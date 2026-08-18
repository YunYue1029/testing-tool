// Running a flow: a sequence of steps that together exercise one feature —
// typically create, read, update, delete — passing values from each result to
// the next and checking what came back. A step either points at a saved
// request, carries one typed straight into it, or runs a shell command, for the
// part of a feature that never shows up in an HTTP response.
import { collections } from './store.ts';
import { runRequest, runScript, resolveVars, SendError } from './runner.ts';
import { runCommand, CommandError, ShellSession, SESSIONS_SUPPORTED } from './shell.ts';
import { substitute, requestVars } from './resolve.ts';
import type {
  Assertion, AssertionResult, Collection, CommandResult, Flow, FlowReport,
  HttpResponse, InlineRequest, ResponseSnapshot, RunnableHttpRequest,
  RunnableRequest, SentRequest, SentSnapshot, ScriptReport, ShellRequest, Step,
  StepReport, ValueSource, Vars,
} from './types.ts';

// Read a value out of a dotted path: "data.items.0.id". Deliberately not full
// JSONPath — this covers what REST responses actually need.
function valueAt(obj: unknown, path: string | undefined): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const key of String(path).split('.')) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function parsedBody(response: HttpResponse): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    return undefined;
  }
}

// Where a value comes from in a response — shared by extractions and assertions.
function readFrom(
  response: HttpResponse,
  source: ValueSource | undefined,
  path?: string,
): unknown {
  switch (source) {
    case 'status': return response.status;
    case 'header': return response.headers[String(path || '').toLowerCase()];
    case 'cookie': return (response.cookies || {})[path as string];
    case 'time': return response.time;
    case 'body':
    default: {
      const body = parsedBody(response);
      // A non-JSON body has no paths; hand back the raw text so `contains`
      // and `matches` still mean something.
      if (body === undefined) return path ? undefined : response.body;
      return valueAt(body, path);
    }
  }
}

function describe(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  return JSON.stringify(v);
}

// Compare loosely on purpose: a JSON body gives numbers, an assertion typed in
// a form gives strings, and "201" should match 201.
function looseEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

// An assertion row nobody filled in: no path, no expected value, and an
// operator that needs one. Editing a step used to save these, and they can
// never pass, so they turn a working flow into a run failing on "status
// expected eq """. Deliberately narrow — `body data.name eq ""` names a field
// and is a real check, as is `exists`, which needs no value.
function pristineAssertion(a: Assertion): boolean {
  const NEEDS_VALUE = !['exists', 'missing'].includes(a.op || 'eq');
  return !a.path && !String(a.value ?? '') && NEEDS_VALUE;
}

// Compare one actual value against an assertion row. Split out from
// evalAssertion so an HTTP response and a command's output are checked by the
// same operators — only where the value is read from differs.
function compare(actual: unknown, a: Assertion, vars: Vars, where: string): AssertionResult {
  const expected = typeof a.value === 'string' ? substitute(a.value, vars) : a.value;

  let ok: boolean;
  switch (a.op) {
    case 'exists': ok = actual !== undefined && actual !== null; break;
    case 'missing': ok = actual === undefined || actual === null; break;
    case 'neq': ok = !looseEq(actual, expected); break;
    case 'contains': ok = String(actual ?? '').includes(String(expected ?? '')); break;
    case 'matches':
      try { ok = new RegExp(String(expected)).test(String(actual ?? '')); }
      catch { return { ok: false, detail: `${where}: invalid regex ${describe(expected)}` }; }
      break;
    case 'lt': ok = Number(actual) < Number(expected); break;
    case 'gt': ok = Number(actual) > Number(expected); break;
    case 'eq':
    default: ok = looseEq(actual, expected); break;
  }

  const op = a.op || 'eq';
  const detail = ok
    ? `${where} ${op}${['exists', 'missing'].includes(op) ? '' : ` ${describe(expected)}`}`
    : ['exists', 'missing'].includes(op)
      ? `${where} expected to ${op}, got ${describe(actual)}`
      : `${where} expected ${op} ${describe(expected)}, got ${describe(actual)}`;
  return { ok, detail };
}

function evalAssertion(response: HttpResponse, a: Assertion, vars: Vars): AssertionResult {
  const where = a.source === 'status' ? 'status'
    : `${a.source || 'body'}${a.path ? ` ${a.path}` : ''}`;
  return compare(readFrom(response, a.source, a.path), a, vars, where);
}

// Where a value comes from in a command's result — the shell counterpart of
// readFrom. stdout that happens to be JSON can be dug into with a path exactly
// like a response body, which is what makes `psql -tAc "select json_agg(…)"`
// a way to assert on what actually landed in the table.
function readFromShell(
  result: CommandResult,
  source: ValueSource | undefined,
  path?: string,
): unknown {
  const text = (s: string): unknown => {
    if (!path) return s;
    try {
      return valueAt(JSON.parse(s), path);
    } catch {
      // Not JSON, so it has no paths — hand back nothing rather than the whole
      // blob, which would make `stdout data.id eq 7` pass on any output at all.
      return undefined;
    }
  };
  switch (source) {
    case 'exit_code': return result.exitCode;
    case 'stderr': return text(result.stderr);
    case 'time': return result.timeMs;
    case 'stdout':
    default: return text(result.stdout);
  }
}

function evalShellAssertion(result: CommandResult, a: Assertion, vars: Vars): AssertionResult {
  const source = a.source || 'stdout';
  const where = ['exit_code', 'time'].includes(source)
    ? source
    : `${source}${a.path ? ` ${a.path}` : ''}`;
  return compare(readFromShell(result, source, a.path), a, vars, where);
}

// How much of a response body travels back in the report. Generous enough to
// read a list endpoint's answer, small enough that nine steps don't add up to a
// download.
const BODY_LIMIT = 20000;

// What a step's response looked like, kept with the step so a run can be
// inspected afterwards without sending everything a second time — the point of
// a flow is that the calls happened in one particular order, and re-running one
// of them alone no longer reproduces it.
function snapshot(response: HttpResponse): ResponseSnapshot {
  const binary = response.bodyEncoding === 'base64';
  // Base64 of an export file is neither readable nor worth the bytes; the
  // reader gets its type and size and can fetch it from the request panel.
  const body = binary ? '' : String(response.body || '');
  return {
    headers: response.headers || {},
    cookies: response.cookies || {},
    size: response.size,
    bodyEncoding: response.bodyEncoding,
    body: body.slice(0, BODY_LIMIT),
    truncated: body.length > BODY_LIMIT,
  };
}

// What the step sent, kept for the same reason the response is: the values were
// resolved from this run's variables, so the saved request no longer says what
// went out — a step that posted {"name":"{{name}}"} is only readable as the
// body it actually built. Trimmed like a response body, so a step that uploads
// something large doesn't double the report.
function sentSnapshot(sent: SentRequest): SentSnapshot {
  const body = typeof sent.body === 'string' ? sent.body : '';
  return {
    method: sent.method,
    url: sent.url,
    headers: sent.headers || {},
    ...(body ? {
      body: body.slice(0, BODY_LIMIT),
      ...(body.length > BODY_LIMIT ? { bodyTruncated: true } : {}),
    } : {}),
    // Field names and text values; a file field's bytes never travelled here,
    // so it is reported as the field it filled.
    ...(sent.form ? {
      form: sent.form.map((f) => (f.type === 'file'
        ? { key: f.key, file: true as const }
        : { key: f.key, value: String(f.value ?? '').slice(0, 2000) })),
    } : {}),
  };
}

// Turn a step's inline request into the shape runRequest expects. The stored
// form keeps one plain `body` string because a step has a single body; a saved
// request carries named variants, which is what `bodies`/`activeBodyId` are for.
function inlineToRequest(r: InlineRequest): RunnableHttpRequest {
  return {
    method: r.method || 'GET',
    url: r.url || '',
    params: r.params || [],
    headers: r.headers || [],
    folderId: null,
    bodyType: r.bodyType || 'none',
    bodies: [{ id: 'inline', name: 'Body', content: r.body || '' }],
    activeBodyId: 'inline',
    // Absent on steps saved before a step could say — and absent means the
    // collection's, which is what they did.
    auth: r.auth,
    script: '',
  };
}

// What a step actually runs, or why it cannot.
type StepTarget =
  | { collection: Collection | null; request: RunnableRequest; error?: undefined }
  | { collection?: undefined; request?: undefined; error: string };

// What a step actually runs: the saved request it points at, or the one typed
// into it. Returns { collection, request } or { error } — the two failures a
// half-filled step and a deleted target produce read very differently, and
// saying "no longer exists" to someone who simply hasn't picked anything sends
// them looking for a deletion that never happened.
async function resolveStepRequest(step: Step): Promise<StepTarget> {
  if (step.mode === 'inline') {
    const inline = step.request || ({} as Partial<InlineRequest>);
    if (!inline.url) return { error: 'This step has no URL yet' };
    // Optional here: only for the collection's base_url and default auth.
    const collection = step.collectionId ? await collections.get(step.collectionId) : null;
    if (step.collectionId && !collection) {
      return { error: 'The collection this step borrows its base URL from no longer exists' };
    }
    return { collection, request: inlineToRequest(inline as InlineRequest) };
  }

  if (!step.collectionId || !step.requestId) {
    return { error: 'This step has no request selected yet' };
  }
  const collection = await collections.get(step.collectionId);
  const request = collection
    ? (collection.requests || []).find((r) => r.id === step.requestId)
    : null;
  if (!request) {
    return {
      error: collection
        ? 'The request this step points at no longer exists in that collection'
        : 'The collection this step points at no longer exists',
    };
  }
  return { collection, request };
}

// What a shell step runs, once the saved test it may point at has been folded in.
interface ShellSpec {
  command: string;
  cwd: string;
  timeout: number | undefined;
  vars: Vars;
  scripts: Array<string | undefined>;
}

// What a shell step actually runs: the command typed into the step, or the one
// carried by the saved shell test it points at. A saved test brings its own
// directory, timeout, variable values and script; the step may override the
// first two and adds its own checks on top, exactly as it does for a saved
// request.
function shellSpec(step: Step, saved: ShellRequest | null): ShellSpec {
  if (!saved) {
    return {
      command: step.command || '',
      cwd: step.cwd || '',
      timeout: step.timeout,
      vars: {},
      scripts: [step.script],
    };
  }
  return {
    command: saved.command || '',
    cwd: step.cwd || saved.cwd || '',
    timeout: step.timeout || saved.timeout,
    vars: requestVars(saved),
    scripts: [saved.script, step.script],
  };
}

interface RunShellStepArgs {
  step: Step;
  spec: ShellSpec;
  base: Pick<StepReport, 'id' | 'name' | 'always'>;
  runVars: Vars;
  vars: Vars;
  abortSignal?: AbortSignal;
  session: ShellSession | null;
  baseCwd?: string;
}

// A step that runs a command instead of sending a request. Extractions,
// assertions and the step's own script all work the way they do for a request —
// only what they read changes — so a flow still reads as one sequence whether a
// given step proves its point over HTTP or at a shell.
async function runShellStep({
  step, spec, base, runVars, vars, abortSignal, session, baseCwd,
}: RunShellStepArgs): Promise<StepReport> {
  // The command is substituted like any other field, which is the whole point:
  // the id the previous step's response gave up is what this one goes looking
  // for in the database.
  const command = substitute(spec.command, vars);
  const stepStarted = Date.now();

  const cwd = substitute(spec.cwd, vars).trim();
  const args = {
    command,
    // A session was already started in the flow's directory and may since have
    // been cd'd somewhere on purpose, so only a step naming its own says
    // anything here. A one-off shell remembers nothing, so it is told every
    // time.
    cwd: cwd || (session ? undefined : baseCwd) || undefined,
    timeout: spec.timeout,
    abortSignal,
  };
  // What this step ran, reported whether or not it produced anything: the
  // resolved command line, the template it came from when a {{var}} made the
  // two differ — that is what you go back and edit — and the directory, since
  // the same command means different things in two checkouts.
  const sent = {
    command,
    ...(spec.command !== command ? { commandRaw: spec.command } : {}),
    ...(args.cwd ? { cwd: args.cwd } : {}),
  };

  let result: CommandResult;
  try {
    // The session, when the flow keeps one, so a step can build on the shell
    // the step before it left behind.
    result = session ? await session.run(args) : await runCommand(args);
  } catch (err) {
    if (err instanceof CommandError && err.cancelled) throw err;
    const e = err as CommandError;
    return {
      ...base,
      ok: false,
      mode: 'shell',
      ...sent,
      timeMs: Date.now() - stepStarted,
      error: e.message || String(err),
      ...(e.hint ? { hint: e.hint } : {}),
    };
  }

  const extracted: Vars = {};
  for (const e of step.extract || []) {
    if (!e || !e.var) continue;
    const v = readFromShell(result, e.from, e.path);
    runVars[e.var] = v == null ? '' : String(v);
    extracted[e.var] = runVars[e.var];
  }

  const assertions = (step.assert || [])
    .filter((a) => a && a.source && !pristineAssertion(a))
    .map((a) => evalShellAssertion(result, a, runVars));

  // A command's exit code is its own verdict — that is what exit codes are for
  // — so a non-zero one fails the step without anyone having to say so. A step
  // that asserts on exit_code takes that judgement over, which is how a check
  // meant to prove a failure (exit_code eq 1) says it expected one.
  const judgesExit = (step.assert || []).some((a) => a && a.source === 'exit_code');
  if (!judgesExit && result.exitCode !== 0) {
    assertions.push({ ok: false, detail: `exit code ${result.exitCode}, expected 0` });
  }

  // The saved test's own script first, then the step's — the same order an
  // HTTP step runs them in, where the request's script has already run by the
  // time the step's does. The first failure is the one reported: after it, what
  // the second script was checking is anyone's guess.
  let script: ScriptReport | undefined;
  for (const src of spec.scripts) {
    if (!(src || '').trim()) continue;
    const checks: AssertionResult[] = [];
    const r = runScript(src, {
      // `res` shaped from the command so a script written for either kind of
      // step reads alike: the exit code is the status, stdout is the body.
      status: result.exitCode,
      statusText: '',
      headers: {},
      cookies: {},
      body: result.stdout,
    }, {
      getVar: (k) => runVars[k],
      setVar: (k, v) => { runVars[k] = v; },
      checks,
      extra: {
        sh: {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timeMs: result.timeMs,
        },
      },
    });
    assertions.push(...checks);
    if (r.error) { script = { error: r.error }; break; }
  }

  const ok = assertions.every((a) => a.ok) && !script;
  return {
    ...base,
    ok,
    mode: 'shell',
    ...sent,
    exitCode: result.exitCode,
    timeMs: result.timeMs,
    // Said out loud because it changes what this step could possibly have seen:
    // something killed the session's shell, so whatever the steps before it had
    // cd'd into or exported is gone and this one started from nothing.
    ...(result.freshShell ? { freshShell: true } : {}),
    ...(Object.keys(extracted).length ? { extracted } : {}),
    ...(assertions.length ? { assertions } : {}),
    ...(script ? { script } : {}),
    shell: {
      stdout: result.stdout.slice(0, BODY_LIMIT),
      stderr: result.stderr.slice(0, BODY_LIMIT),
      truncated: result.stdout.length > BODY_LIMIT || result.stderr.length > BODY_LIMIT,
    },
  };
}

// One shell for the whole run, unless the flow asked for the old behaviour of a
// fresh one per command. A run is a sequence, and its shell steps are usually a
// sequence too — cd into the checkout, source the env, migrate, then look at
// what landed — which only works if the shell is still the same one. The
// session is built here and not started until a shell step actually wants it,
// so a flow of pure HTTP never spawns anything.
function shellSessionFor(flow: Flow): ShellSession | null {
  if (!SESSIONS_SUPPORTED) return null;
  const settings = flow.shell || ({} as Partial<Flow['shell']>);
  if (settings.session === false) return null;
  return new ShellSession({ cwd: settings.cwd || undefined });
}

export interface RunFlowOptions {
  environmentId?: string;
  abortSignal?: AbortSignal;
}

// Run every step in order. Values captured by one step are visible to the next
// through a run-scoped variable map — never written back to the stored
// environment, so a CRUD flow doesn't leave an id behind and two runs can't
// tread on each other.
async function runFlow(
  flow: Flow,
  { environmentId, abortSignal }: RunFlowOptions = {},
): Promise<FlowReport> {
  const envId = environmentId || flow.environmentId || undefined;
  const runVars: Vars = {};
  const started = Date.now();
  const steps: StepReport[] = [];
  const session = shellSessionFor(flow);
  let failed = false;

  // What a command's {{vars}} resolve against: the environment underneath, the
  // saved test's own values over it, and whatever this run has captured on top
  // — the same order a request resolves in. Read once, and only if some step
  // actually runs a command, so a flow of pure HTTP still touches nothing.
  let envShellVars: Vars | null = null;
  async function shellStepVars(spec: ShellSpec): Promise<Vars> {
    if (!envShellVars) {
      ({ vars: envShellVars } = await resolveVars({ environmentId: envId, collection: null }));
    }
    return { ...envShellVars, ...spec.vars, ...runVars };
  }

  try {
    for (const step of flow.steps || []) {
      const base = { id: step.id, name: step.name || '', always: !!step.always };

      if (step.enabled === false) {
        steps.push({ ...base, ok: true, skipped: 'disabled' });
        continue;
      }
      // Once something has failed the rest of the chain is meaningless — it was
      // going to act on an id that never got created. Teardown still runs, or a
      // failed run would leave its rows behind.
      if (failed && !step.always) {
        steps.push({ ...base, ok: true, skipped: 'an earlier step failed' });
        continue;
      }

      // Either the command is typed into the step, or the step points at a
      // saved shell test — a command filed in a collection because more than
      // one flow needs it. Both run here, through the shell this run shares.
      const runCommandStep = async (spec: ShellSpec): Promise<void> => {
        const entry = await runShellStep({
          step,
          spec,
          base,
          runVars,
          vars: await shellStepVars(spec),
          abortSignal,
          session,
          baseCwd: (flow.shell || {}).cwd,
        });
        steps.push(entry);
        if (!entry.ok) failed = true;
      };

      if (step.mode === 'shell') {
        await runCommandStep(shellSpec(step, null));
        continue;
      }

      const target = await resolveStepRequest(step);
      if (target.error !== undefined) {
        steps.push({ ...base, ok: false, error: target.error });
        failed = true;
        continue;
      }
      const { collection, request } = target;

      if (request.kind === 'shell') {
        await runCommandStep(shellSpec(step, request));
        continue;
      }

      let out;
      const stepStarted = Date.now();
      try {
        out = await runRequest({
          collection,
          request,
          environmentId: envId,
          vars: runVars,
          overrides: step.overrides,
          abortSignal,
          // Keep env.set() from the request's own script inside the run. Reused
          // login requests already call it, and a flow wants the token without
          // the environment acquiring one.
          onSetVar: (k, v) => { runVars[k] = v; },
        });
      } catch (err) {
        if (err instanceof SendError && err.cancelled) throw err;
        const e = err as SendError;
        steps.push({
          ...base,
          ok: false,
          timeMs: Date.now() - stepStarted,
          error: err instanceof SendError ? e.message : (e.message || String(err)),
          // Nothing came back, so the call itself is all there is to read — and
          // a url that resolved to something unexpected is half the reason a
          // send fails at all. Only runRequest reaches here, so what it
          // attached is the HTTP call it was about to make.
          ...(e.sent ? { request: sentSnapshot(e.sent as SentRequest) } : {}),
        });
        failed = true;
        continue;
      }

      const { response } = out;

      // Extractions first: assertions and the step script should both see them.
      const extracted: Vars = {};
      for (const e of step.extract || []) {
        if (!e || !e.var) continue;
        const v = readFrom(response, e.from, e.path);
        runVars[e.var] = v == null ? '' : String(v);
        extracted[e.var] = runVars[e.var];
      }

      const assertions = (step.assert || [])
        .filter((a) => a && a.source && !pristineAssertion(a))
        .map((a) => evalAssertion(response, a, runVars));

      // The step's own script, for checks the declarative rules can't express.
      let script: ScriptReport | undefined;
      if ((step.script || '').trim()) {
        const checks: AssertionResult[] = [];
        const r = runScript(step.script, response, {
          getVar: (k) => runVars[k],
          setVar: (k, v) => { runVars[k] = v; },
          checks,
        });
        assertions.push(...checks);
        if (r.error) script = { error: r.error };
      }

      // The request's own script failing is a step failure too.
      if (out.script && out.script.error) script = { error: out.script.error };

      const ok = assertions.every((a) => a.ok) && !script;
      steps.push({
        ...base,
        ok,
        request: sentSnapshot(out.request),
        status: response.status,
        statusText: response.statusText,
        timeMs: response.time,
        ...(Object.keys(extracted).length ? { extracted } : {}),
        ...(assertions.length ? { assertions } : {}),
        ...(script ? { script } : {}),
        response: snapshot(response),
      });
      if (!ok) failed = true;
    }
  } finally {
    // Including after a cancel, which throws straight out of the loop: a
    // session left open is a shell process nobody is ever going to talk to
    // again, still holding whatever its last command started.
    if (session) await session.dispose();
  }

  return {
    flowId: flow.id,
    name: flow.name,
    ok: !failed,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    steps,
    vars: runVars,
  };
}

export {
  runFlow, valueAt, readFrom, readFromShell, evalAssertion, evalShellAssertion, pristineAssertion,
};
