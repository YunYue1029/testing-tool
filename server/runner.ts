// Running requests: turning a stored (or in-flight) request definition into an
// actual HTTP call, and running its post-response script.
//
// Everything that decides what goes out lives here, so the browser, the MCP
// server and the flow runner all send the same thing. They used to each build
// the call themselves and had already drifted — MCP never set Content-Type for
// JSON bodies, never sent form-data, and never ran scripts.
import vm from 'node:vm';
import { files, environments } from './store.ts';
import { runCommand, CommandError } from './shell.ts';
import {
  substitute, rowsToObject, buildUrl, composeUrl, requestAuthHeader,
  applyCollectionBaseUrl, envVars, requestVars, DEFAULT_BASE_URL,
} from './resolve.ts';
import type {
  AssertionResult, Collection, Environment, HttpResponse, Overrides, RunnableHttpRequest,
  HttpRunResult, ScriptReport, ScriptResponse, ScriptResult, SentFormRow, SentRequest,
  SentShellCommand, ShellRequest, ShellResponse, ShellRunResult, Vars,
} from './types.ts';

// A failure that carries the HTTP status and hint to answer with.
class SendError extends Error {
  status: number;
  hint: string | undefined;
  // What went out, attached by runRequest so a caller with no response to show
  // can still report the call that failed.
  sent?: SentRequest | SentShellCommand;
  cancelled?: boolean;

  constructor(status: number, error: string, hint?: string) {
    super(error);
    this.status = status;
    this.hint = hint;
  }
}

// Is this response body safe to hand over as text? Content-Type decides when
// it says anything useful; otherwise fall back to sniffing for NUL bytes,
// which text practically never contains but binary formats do.
function isTextual(contentType: string | undefined, buf: Buffer): boolean {
  const ct = (contentType || '').toLowerCase();
  if (ct) {
    if (/^text\//.test(ct)) return true;
    if (/(^|\/|\+)(json|xml|yaml|javascript|ecmascript|x-ndjson|csv|html|urlencoded)\b/.test(ct)) return true;
    if (/charset=/.test(ct)) return true;
    if (/^(image|audio|video|font)\//.test(ct)) return false;
    if (/^application\/(octet-stream|pdf|zip|gzip|x-tar|x-protobuf|wasm)/.test(ct)) return false;
  }
  return !buf.subarray(0, 8192).includes(0);
}

interface PerformSendArgs {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  form?: SentFormRow[];
  timeout?: number;
}

// Perform one HTTP call, on a url that is already resolved. Nothing outside
// this file calls it — runRequest below is the only way in, so every send has
// been through resolve.ts. `abortSignal` lets a caller (the request handler)
// drop the upstream call when whoever asked for it has gone away.
async function performSend(
  { method = 'GET', url, headers = {}, body, form, timeout }: PerformSendArgs,
  abortSignal?: AbortSignal,
): Promise<HttpResponse> {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new SendError(400, 'A valid http(s) URL is required');
  }

  const outHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k && v != null && String(v).length) outHeaders[k] = String(v);
  }

  // multipart/form-data: rebuild the form here, pulling each file row's bytes
  // out of the uploads store.
  let outBody: string | FormData | undefined = body;
  if (Array.isArray(form) && form.length) {
    const fd = new FormData();
    for (const row of form) {
      if (!row || !row.key) continue;
      if (row.type === 'file') {
        const f = await files.read(row.fileId);
        if (!f) {
          throw new SendError(400, `The file for field "${row.key}" is no longer stored — pick it again.`);
        }
        fd.append(row.key, new Blob([f.buffer], { type: f.meta.type }), f.meta.name);
      } else {
        fd.append(row.key, String(row.value == null ? '' : row.value));
      }
    }
    outBody = fd;
    // fetch generates the multipart boundary itself; a hand-set Content-Type
    // would carry a stale boundary (or none) and the target could not parse
    // the body, so drop any the user set.
    for (const k of Object.keys(outHeaders)) {
      if (k.toLowerCase() === 'content-type') delete outHeaders[k];
    }
  }

  const hasBody = !['GET', 'HEAD'].includes(method.toUpperCase())
    && outBody != null && outBody !== '';

  const timeoutMs = Number(timeout) > 0 ? Math.min(Number(timeout), 600000) : 30000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signals = [timeoutSignal];
  if (abortSignal) signals.push(abortSignal);

  const started = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: method.toUpperCase(),
      headers: outHeaders,
      body: hasBody ? outBody : undefined,
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (abortSignal && abortSignal.aborted) {
      const e = new SendError(499, 'Cancelled');
      e.cancelled = true;
      throw e;
    }
    if (timeoutSignal.aborted) {
      throw new SendError(
        504,
        `No response within ${timeoutMs / 1000}s — the request was given up on.`,
        'The target may be slow, unreachable, or waiting on something. Raise the timeout if it is just slow.',
      );
    }
    // Node's fetch reports a generic "fetch failed" and hides the reason on
    // err.cause, where the code is an undici identifier meaningless to anyone
    // who hasn't read undici's source. Say what happened instead.
    const cause = (err as { cause?: { code?: string; message?: string } }).cause || {};
    const failures: Record<string, { message: string; hint?: string }> = {
      ENOTFOUND: {
        message: 'Host not found',
        hint: 'Check the domain name. A target running in a container reaches this machine as localhost only if its port is published.',
      },
      ECONNREFUSED: {
        message: 'Connection refused — nothing is listening there',
        hint: 'Is the target server running, and on that port? A containerised target needs that port published to the host.',
      },
      ETIMEDOUT: { message: 'The host did not respond' },
      ECONNRESET: { message: 'The target server reset the connection' },
      UND_ERR_SOCKET: {
        message: 'The target accepted the connection, then closed it without answering',
        hint: 'Usually the server restarted or crashed on this request (check its log), '
          + 'or the port speaks HTTPS and the URL says http://. Send again — if it succeeds, it was a restart.',
      },
      UND_ERR_REQ_CONTENT_LENGTH_MISMATCH: {
        message: 'The Content-Length header does not match the body',
        hint: 'Remove the Content-Length header — it is computed from the body. Postman exports often carry a stale one.',
      },
      UND_ERR_HEADERS_TIMEOUT: { message: 'The target accepted the request but sent no response headers in time' },
      CERT_HAS_EXPIRED: { message: 'The target TLS certificate has expired' },
      DEPTH_ZERO_SELF_SIGNED_CERT: { message: 'The target uses a self-signed certificate' },
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: { message: 'The target TLS certificate could not be verified' },
      ERR_TLS_CERT_ALTNAME_INVALID: { message: 'The TLS certificate does not cover this hostname' },
    };
    const known = cause.code ? failures[cause.code] : undefined;
    // Keep the raw code on unknown failures — it is the only clue left.
    const message = known ? known.message : (cause.message || cause.code || (err as Error).message);
    throw new SendError(502, `Request failed: ${message}`, known && known.hint);
  }
  const elapsed = Date.now() - started;

  const buf = Buffer.from(await upstream.arrayBuffer());
  const respHeaders: Record<string, string> = {};
  upstream.headers.forEach((v, k) => { respHeaders[k] = v; });

  // Cookies as {name: value}, so post-response scripts can persist them
  // (e.g. an HttpOnly refresh-token cookie) via env.set().
  const cookies: Record<string, string> = {};
  const setCookies = typeof upstream.headers.getSetCookie === 'function'
    ? upstream.headers.getSetCookie() : [];
  for (const sc of setCookies) {
    const m = /^([^=;]+)=([^;]*)/.exec(sc);
    if (m) cookies[m[1]!.trim()] = m[2]!;
  }

  // Decoding an image or a PDF as UTF-8 replaces every byte it can't map, so
  // the payload can neither be read nor saved. Send those through as base64
  // and let the caller offer a download instead.
  const textual = isTextual(respHeaders['content-type'], buf);

  return {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
    cookies,
    body: buf.toString(textual ? 'utf8' : 'base64'),
    bodyEncoding: textual ? 'utf8' : 'base64',
    time: elapsed,
    size: buf.length,
  };
}

export interface RunScriptOptions {
  getVar: (k: string) => string | undefined;
  setVar: (k: string, v: string) => void;
  timeoutMs?: number;
  // When given, receives every expect() call the script makes.
  checks?: AssertionResult[];
  // Extra bindings for the script's context — how a shell step offers `sh`.
  extra?: Record<string, unknown>;
}

// Run a post-response script. It is the user's own code on their own machine,
// so this is not a security sandbox — the timeout is there so a stray loop
// can't wedge the server, which is what changed when scripts moved off the
// browser's main thread and onto this one.
//
// `setVar(name, value)` receives every env.set() call; the caller decides where
// those land (the stored environment, or a flow's run-scoped variables).
// `checks`, when given, is an array that receives every expect() call — that
// is how a flow step asserts something the declarative rules can't express.
// `extra`, when given, adds bindings to the script's context — how a flow's
// shell step offers `sh` (exit code, stdout, stderr) alongside the `res` a
// response-shaped step gets.
function runScript(
  script: string | undefined,
  response: ScriptResponse,
  { getVar, setVar, timeoutMs = 2000, checks, extra }: RunScriptOptions,
): ScriptResult {
  const src = (script || '').trim();
  if (!src) return { ran: false };

  const resApi = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    cookies: response.cookies || {},
    body: response.body,
    json() { return JSON.parse(response.body); },
  };
  const envApi = {
    get: (k: string) => getVar(k),
    set: (k: string, v: unknown) => {
      if (!/^[\w.-]+$/.test(k)) throw new Error(`env.set: "${k}" is not a valid variable name`);
      setVar(k, String(v));
    },
  };

  const context = vm.createContext({
    res: resApi,
    env: envApi,
    JSON,
    console: { log: () => {} },
    ...(checks ? {
      expect: (cond: unknown, message?: string) => {
        checks.push({ ok: !!cond, detail: message || 'expect(…)' });
      },
    } : {}),
    ...(extra || {}),
  });
  try {
    // Wrapped in a function so `return` works in a script, matching what the
    // browser's `new Function` allowed.
    vm.runInContext(`(function(){\n${src}\n})()`, context, { timeout: timeoutMs });
    return { ran: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const msg = e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
      ? `Script did not finish within ${timeoutMs / 1000}s — check for an endless loop.`
      : (e.message || String(err));
    return { ran: true, error: msg };
  }
}

// Everything needed to send one saved request: resolve variables, expand
// {{dy_url}} from the folder path, apply the collection's default auth, pick
// the right body, and — the part MCP never did — set Content-Type for JSON and
// pass form-data fields through.
//
// `collection` may be null for an ad-hoc request that isn't filed anywhere.
function buildRequest(
  collection: Collection | null,
  request: RunnableHttpRequest,
  vars: Vars,
  overrides: Overrides = {},
): SentRequest {
  const folders = collection ? collection.folders || [] : [];
  let url = buildUrl(composeUrl(folders, request.folderId, request.url), request.params, vars);
  const headers = rowsToObject(request.headers, vars);

  // Whichever auth the request runs under — the collection's default, its own,
  // or none — unless it sets that header itself on the Headers tab. Sending
  // none is what a login needs: the collection's default is the token a login
  // is about to replace, and a backend that reads anything from the token it
  // was handed (a timezone claim, say) will answer the login as the stale
  // token's user.
  const ah = requestAuthHeader(collection, request);
  if (ah && !Object.keys(headers).some((k) => k.toLowerCase() === ah.name.toLowerCase())) {
    headers[ah.name] = substitute(ah.value, vars);
  }

  let body: string | undefined;
  let form: SentFormRow[] | undefined;
  if (request.bodyType === 'form') {
    form = (request.form || [])
      .filter((r) => r.enabled !== false && r.key)
      .map((r): SentFormRow => (r.type === 'file'
        ? { key: substitute(r.key, vars), type: 'file', fileId: r.fileId }
        : { key: substitute(r.key, vars), type: 'text', value: substitute(r.value || '', vars) }))
      .filter((r) => r.type !== 'file' || r.fileId);
  } else if (request.bodyType && request.bodyType !== 'none') {
    const active = (request.bodies || []).find((b) => b.id === request.activeBodyId)
      || (request.bodies || [])[0];
    if (active && active.content) {
      body = substitute(active.content, vars);
      // Without this a JSON body goes out as text/plain (fetch's default for a
      // string), which strict APIs reject with 415.
      if (request.bodyType === 'json'
        && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  if (overrides.url != null) url = substitute(overrides.url, vars);
  if (overrides.headers) {
    for (const [k, v] of Object.entries(overrides.headers)) {
      headers[substitute(k, vars)] = substitute(v, vars);
    }
  }
  if (overrides.body != null) { body = substitute(overrides.body, vars); form = undefined; }

  return { method: (request.method || 'GET').toUpperCase(), url, headers, body, form };
}

interface ResolveVarsArgs {
  environmentId?: string | undefined;
  collection: Collection | null;
  vars?: Vars;
}

// The variables a run starts from: the environment, the collection's base_url
// override, then anything the caller supplies (a flow's run-scoped values,
// which must win over the stored environment).
async function resolveVars(
  { environmentId, collection, vars: extra }: ResolveVarsArgs,
): Promise<{ vars: Vars; env: Environment | null }> {
  let env: Environment | null = null;
  if (environmentId) {
    const list = await environments.list();
    env = list.find((e) => e.id === environmentId || e.name === environmentId) || null;
    if (!env) throw new SendError(400, `Environment "${environmentId}" not found`);
  }
  let vars = envVars(env);
  if (vars.base_url == null || vars.base_url === '') vars.base_url = DEFAULT_BASE_URL;
  vars = applyCollectionBaseUrl(vars, collection);
  return { vars: { ...vars, ...(extra || {}) }, env };
}

// Where a script's env.set() calls end up. Into the stored environment for a
// plain run, or nowhere at all when the caller is capturing them itself (a flow
// keeping its values run-scoped). Returns what to report as saved.
async function persistScriptVars(
  script: ScriptResult,
  changes: Vars,
  env: Environment | null,
  onSetVar?: SetVar,
): Promise<Vars | undefined> {
  if (script.error || !Object.keys(changes).length) return undefined;
  if (onSetVar) return changes;
  if (!env) {
    // the caller reports this back as the script's own failure
    script.error = 'env.set() needs an active environment — select or create one first';
    return undefined;
  }
  await environments.save({
    ...env,
    variables: { ...(env.variables || {}), ...changes },
    // setting a variable re-enables it if it was unchecked
    disabled: (env.disabled || []).filter((k) => !(k in changes)),
  });
  return changes;
}

export type SetVar = (k: string, v: string) => void;

export interface RunShellRequestArgs {
  collection: Collection | null;
  request: ShellRequest;
  environmentId?: string | undefined;
  vars?: Vars;
  timeout?: number;
  abortSignal?: AbortSignal;
  onSetVar?: SetVar;
}

// Run one saved shell test end to end — the counterpart of runRequest for a
// test that proves its point at a shell instead of over HTTP: that the row
// really landed, the file was written, the queue drained. Same resolution rules
// as a request (environment, then the test's own values), same script, so the
// two kinds of test differ only in what they do in the middle.
//
// A one-off shell per run, deliberately: a test in a collection is a thing you
// run on its own, and there is no earlier step here for it to carry on from.
// Inside a flow it goes through runShellStep instead, which shares the run's
// shell.
async function runShellRequest({
  collection, request, environmentId, vars: extraVars, timeout, abortSignal, onSetVar,
}: RunShellRequestArgs): Promise<ShellRunResult> {
  const { vars, env } = await resolveVars({
    environmentId,
    collection,
    vars: { ...requestVars(request), ...(extraVars || {}) },
  });

  const command = substitute(request.command || '', vars);
  if (!command.trim()) throw new SendError(400, 'This shell test has no command yet');
  const cwd = substitute(request.cwd || '', vars).trim();
  // What ran, not what is stored: a command built from {{vars}} is only
  // readable as the line it actually became, and the template beside it is what
  // you would go back and edit.
  const sent: SentShellCommand = {
    command,
    ...(request.command !== command ? { commandRaw: request.command } : {}),
    ...(cwd ? { cwd } : {}),
  };

  let result;
  try {
    result = await runCommand({
      command,
      cwd: cwd || undefined,
      timeout: timeout || request.timeout,
      abortSignal,
    });
  } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    if (err.cancelled) {
      const e = new SendError(499, 'Cancelled');
      e.cancelled = true;
      throw e;
    }
    // A command that could not run at all — no command written, killed on the
    // timeout, no such directory. A command that ran and exited non-zero is not
    // this: that is a result, and it comes back below as one.
    const e = new SendError(400, err.message, err.hint);
    e.sent = sent;
    throw e;
  }

  const response: ShellResponse = {
    kind: 'shell',
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    time: result.timeMs,
    size: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
  };

  const changes: Vars = {};
  const script = runScript(request.script, {
    // Shaped from the command so one script API covers both kinds of test: the
    // exit code is the status, stdout is the body. `sh` is there for what that
    // shape has no room for — stderr, and the exit code under its own name.
    status: result.exitCode,
    statusText: '',
    headers: {},
    cookies: {},
    body: result.stdout,
  }, {
    getVar: (k) => (Object.prototype.hasOwnProperty.call(changes, k) ? changes[k] : vars[k]),
    setVar: (k, v) => {
      changes[k] = v;
      if (onSetVar) onSetVar(k, v);
    },
    extra: {
      sh: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timeMs: result.timeMs,
      },
    },
  });

  const saved = await persistScriptVars(script, changes, env, onSetVar);

  return {
    request: sent,
    response,
    script: script.ran
      ? { ...(saved ? { saved } : {}), ...(script.error ? { error: script.error } : {}) } satisfies ScriptReport
      : undefined,
    vars: changes,
  };
}

export interface RunRequestArgs {
  collection: Collection | null;
  request: RunnableHttpRequest;
  environmentId?: string | undefined;
  vars?: Vars;
  overrides?: Overrides;
  timeout?: number;
  abortSignal?: AbortSignal;
  // Where env.set() writes. Defaults to persisting into the active
  // environment, which is what a plain run from the app or MCP means.
  onSetVar?: SetVar;
}

// Run one request end to end. Returns what was sent, what came back, and what
// the script did.
async function runRequest({
  collection, request, environmentId, vars: extraVars, overrides, timeout, abortSignal,
  onSetVar,
}: RunRequestArgs): Promise<HttpRunResult> {
  // The request's own values sit between the environment and whatever the
  // caller passes: they beat the environment (that is the point of keeping an
  // id on the request), but a flow's captured value — the id step 1 just
  // created — must still beat the one saved on the request.
  const { vars, env } = await resolveVars({
    environmentId,
    collection,
    vars: { ...requestVars(request), ...(extraVars || {}) },
  });
  const sent = buildRequest(collection, request, vars, overrides);
  let response: HttpResponse;
  try {
    response = await performSend({ ...sent, timeout }, abortSignal);
  } catch (err) {
    // A refused connection or a timeout is exactly when what went out matters,
    // and there is no response to hang it off — so the error carries it, and a
    // flow can keep it with the step that failed.
    if (err instanceof SendError) err.sent = sent;
    throw err;
  }

  const changes: Vars = {};
  const script = runScript(request.script, response, {
    getVar: (k) => (Object.prototype.hasOwnProperty.call(changes, k) ? changes[k] : vars[k]),
    setVar: (k, v) => {
      changes[k] = v;
      if (onSetVar) onSetVar(k, v);
    },
  });

  const saved = await persistScriptVars(script, changes, env, onSetVar);

  return {
    // What went out rather than what is stored: {{vars}} resolved, the folder
    // path composed, auth applied, Content-Type set. The body comes back too —
    // a caller that wants to show the call afterwards (a flow report) cannot
    // rebuild it from the saved request, whose {{vars}} mean something else by
    // then.
    request: {
      method: sent.method, url: sent.url, headers: sent.headers,
      body: sent.body, form: sent.form,
    },
    response,
    script: script.ran
      ? { ...(saved ? { saved } : {}), ...(script.error ? { error: script.error } : {}) }
      : undefined,
    vars: changes,
  };
}

export {
  SendError, runScript, buildRequest, resolveVars, runRequest, runShellRequest,
};
