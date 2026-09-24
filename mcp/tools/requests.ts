// Requests and shell tests: reading one, sending (ad-hoc or saved), writing
// one, and the named bodies a request keeps beside the one it sends.
import { z } from 'zod';
import { api } from '../api.ts';
import { newId } from '../../server/ids.ts';
import { requestAuthType } from '../../server/resolve.ts';
import type { Auth, HttpRequest, ShellRequest } from '../../server/types.ts';
import {
  authIn, bodyVariants, findVariant, guessBodyType, httpRequestIn, requireCollection,
  requireEnv, requireFolder, requireRequest, requireVariant, rowsToPlainObject, shapeResponse,
  toRows, variantReport, varsOut, varsToRows, varValue,
} from '../shape.ts';
import type { Tool } from '../server.ts';

export function register(tool: Tool): void {
  tool('get_request', {
    title: 'Get request detail',
    description:
      'The full content of one saved request or shell test. body is the variant that gets sent, ' +
      'body_variants names the rest, and body_variant reads one of the others instead.',
    inputSchema: {
      collection_id: z.string(),
      request_id: z.string(),
      body_variant: z.string().optional(),
    },
  }, async ({ collection_id, request_id, body_variant }) => {
    const c = await requireCollection(collection_id);
    const r = requireRequest(c, request_id);
    if (r.kind === 'shell') {
      return {
        request_id: r.id,
        name: r.name,
        kind: 'shell',
        command: r.command || '',
        cwd: r.cwd || '',
        timeout_ms: r.timeout || null,
        vars: await varsOut(r.vars),
        script: r.script || '',
      };
    }
    const { bodies, activeId } = bodyVariants(r);
    const body = body_variant !== undefined
      ? requireVariant(r, bodies, body_variant)
      : bodies.find((b) => b.id === activeId);
    return {
      request_id: r.id,
      name: r.name,
      method: r.method,
      url: r.url,
      params: rowsToPlainObject(r.params),
      headers: rowsToPlainObject(r.headers),
      body_type: r.bodyType || 'none',
      // Which variant the content below is, since it is no longer always the
      // active one, and what else is stored beside it.
      body_name: body ? body.name : null,
      body: body ? body.content : '',
      ...(bodies.length > 1
        ? { body_variants: bodies.map((b) => ({ name: b.name, active: b.id === activeId })) }
        : {}),
      // Values kept on the request itself, which beat the environment when it
      // runs — without them it is impossible to tell from here why {{user_id}}
      // resolves for this request and nowhere else.
      vars: await varsOut(r.vars),
      // Only when the request does not simply inherit — otherwise a login here
      // looks identical to one that carries the collection's token.
      ...(requestAuthType(r) === 'inherit' ? {} : { auth: r.auth || { type: 'none' } }),
      script: r.script || '',
    };
  });

  tool('send_request', {
    title: 'Send an HTTP request',
    description:
      'Send an ad-hoc HTTP request through the backend, {{vars}} resolved from environment; ' +
      'body_type is guessed from the body. max_body_chars raises the body cap.',
    inputSchema: {
      method: z.string(),
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      environment: z.string().optional(),
      max_body_chars: z.number().int().positive().optional(),
    },
  }, async ({ method, url, headers, body, environment, max_body_chars }) => {
    if (environment) await requireEnv(environment);
    // Handed to the backend unresolved, as a request that simply isn't filed
    // anywhere: it substitutes {{vars}} and sets Content-Type for a JSON body,
    // exactly as it does for a saved one. Resolving it here is how this tool
    // used to send something the app never would. With no collection there is
    // no folder path, so {{dy_url}} amounts to {{base_url}}.
    const record: HttpRequest = {
      id: newId(),
      name: 'Ad-hoc request',
      method,
      url,
      params: [],
      headers: toRows(headers),
      bodyType: guessBodyType(body),
      bodies: [{ id: newId(), name: 'Default', content: body == null ? '' : body }],
      script: '',
    };
    record.activeBodyId = record.bodies![0]!.id;
    const out = await api.run({ request: record, environment });
    return shapeResponse(out.response, max_body_chars);
  });

  tool('run_saved_request', {
    title: 'Run a saved request',
    description:
      'Run a saved request or shell test by id. overrides replace url/headers/body for this run; ' +
      'body_variant sends one of the stored bodies (save_body_variant) instead of the active one ' +
      'and needs body_type json or text. A shell test takes no overrides.',
    inputSchema: {
      collection_id: z.string(),
      request_id: z.string(),
      environment: z.string().optional(),
      body_variant: z.string().optional(),
      overrides: z
        .object({
          url: z.string().optional(),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().optional(),
        })
        .optional(),
      max_body_chars: z.number().int().positive().optional(),
    },
  }, async ({ collection_id, request_id, environment, body_variant, overrides, max_body_chars }) => {
    // A named variant is sent as a body override, so the stored active one is
    // not disturbed by a run. Both would be two answers to the same question.
    let sent = overrides;
    if (body_variant !== undefined) {
      if (overrides && overrides.body !== undefined) {
        throw new Error('Pass either body_variant or overrides.body, not both.');
      }
      const { request } = await httpRequestIn(collection_id, request_id);
      // The override would go out whatever the type says, which is not what
      // choosing among stored bodies means for a request that sends none.
      const type = request.bodyType || 'none';
      if (type === 'none' || type === 'form') {
        throw new Error(
          `"${request.name}" has body_type ${type}, so no stored body is sent — `
          + 'set body_type json or text with save_request first, or pass overrides.body.',
        );
      }
      const variant = requireVariant(request, bodyVariants(request).bodies, body_variant);
      sent = { ...overrides, body: variant.content };
    }
    // The backend resolves and sends it — the same code path the app uses.
    // Rebuilding the call here is how this tool ended up not setting
    // Content-Type for JSON, not sending form-data and not running scripts.
    const out = await api.run({
      collection_id,
      request_id,
      environment,
      overrides: sent,
    });
    return {
      ...shapeResponse(out.response, max_body_chars),
      // Present when the request has a post-response script.
      ...(out.script ? { script: out.script } : {}),
    };
  });

  tool('save_request', {
    title: 'Save a request',
    description:
      'Add (no request_id) or update (request_id) an endpoint: name, method, url, headers, params, ' +
      'body_type, body, folder_id, vars, auth, script. On update every omitted field keeps its ' +
      'value, including the form-data fields and extra body variants this schema cannot express; ' +
      'pass {} to clear headers/params/vars. See the instructions for {{dy_url}}, vars, auth and ' +
      'script.',
    inputSchema: {
      collection_id: z.string(),
      request: z.object({
        request_id: z.string().optional(),
        name: z.string(),
        method: z.string(),
        url: z.string(),
        headers: z.record(z.string(), z.string()).optional(),
        params: z.record(z.string(), z.string()).optional(),
        body_type: z.enum(['none', 'json', 'text']).optional(),
        body: z.string().optional(),
        folder_id: z.string().optional(),
        vars: z.record(z.string(), varValue).optional(),
        auth: authIn.optional(),
        script: z.string().optional(),
      }),
    },
  }, async ({ collection_id, request }) => {
    const c = await requireCollection(collection_id);
    if (request.folder_id) requireFolder(c, request.folder_id);

    // Saved requests are opened in the UI, so they keep the trailing empty row
    // an editable list expects.
    const rows = (obj?: Record<string, string>) => toRows(obj, { trailingBlank: true });

    const prev = request.request_id
      ? (c.requests || []).find((x) => x.id === request.request_id) || null
      : null;
    // Spreading a shell test into an HTTP record would carry its kind and
    // command along, leaving a request that runs a command.
    if (prev && prev.kind === 'shell') {
      throw new Error(
        `Request "${request.request_id}" in "${c.name}" is a shell test, not an HTTP request — `
        + 'save it with save_shell_test, or leave request_id off to create a new request.',
      );
    }

    // An update carries over everything the caller didn't pass. This schema
    // models neither form-data fields (with their uploaded files) nor extra
    // body variants, so rebuilding the record from scratch would silently
    // destroy them — as omitting folder_id already avoids doing.

    // Body edits replace the active variant's content; the others survive.
    let bodies = prev && Array.isArray(prev.bodies) && prev.bodies.length
      ? prev.bodies
      : [{ id: newId(), name: 'Default', content: '' }];
    const activeBodyId = bodies.some((b) => prev && b.id === prev.activeBodyId)
      ? prev!.activeBodyId!
      : bodies[0]!.id;
    if (request.body !== undefined) {
      const content = request.body;
      bodies = bodies.map((b) => (b.id === activeBodyId ? { ...b, content } : b));
    }

    const record: HttpRequest = {
      ...prev, // form rows, uploaded file ids, script, anything newer than this tool
      id: request.request_id || newId(),
      name: request.name,
      method: request.method.toUpperCase(),
      url: request.url,
      params: request.params !== undefined ? rows(request.params) : (prev ? prev.params : rows()),
      headers: request.headers !== undefined ? rows(request.headers) : (prev ? prev.headers : rows()),
      // A new request with a body but no body_type takes the type the body
      // implies — stored as 'none', the body would never be sent.
      bodyType: request.body_type || (prev ? prev.bodyType || 'none' : guessBodyType(request.body)),
      bodies,
      activeBodyId,
      folderId: request.folder_id !== undefined
        ? (request.folder_id || null)
        : (prev ? prev.folderId || null : null),
      vars: request.vars !== undefined
        ? await varsToRows(request.vars, { trailingBlank: true })
        : (prev ? prev.vars || [] : []),
      // Omitted keeps what is there, whole — reducing it to its type alone
      // would drop the token beside it. Dropping noAuth as the request is
      // rewritten keeps one live answer per request rather than a stale
      // boolean sitting next to the type that replaced it.
      auth: request.auth !== undefined
        ? (request.auth as Auth)
        : (prev && prev.auth ? prev.auth : { type: requestAuthType(prev) } as Auth),
      noAuth: undefined,
      // The script the backend runs after the response. Omitting it keeps the
      // one already saved, the way every other field here behaves — pass '' to
      // remove it.
      script: request.script !== undefined ? request.script : (prev ? prev.script || '' : ''),
    };

    const saved = await api.putRequest(c.id, record);
    return { collection_id: saved.id, request_id: record.id, request: record };
  });

  tool('save_body_variant', {
    title: 'Save a body variant',
    description:
      'Add a named body to a request, or replace one by name — the "valid" / "missing field" ' +
      'payloads a route is tested with, kept side by side. save_request only ever writes the active ' +
      'variant; activate:true makes this one the sent one.',
    inputSchema: {
      collection_id: z.string(),
      request_id: z.string(),
      name: z.string(),
      content: z.string(),
      activate: z.boolean().optional(),
    },
  }, async ({ collection_id, request_id, name, content, activate }) => {
    const { collection, request } = await httpRequestIn(collection_id, request_id);
    const { bodies, activeId } = bodyVariants(request);
    const existing = findVariant(bodies, name);
    const variant = existing || { id: newId(), name, content };
    const record: HttpRequest = {
      ...request,
      bodies: existing
        ? bodies.map((b) => (b.id === existing.id ? { ...b, content } : b))
        : [...bodies, variant],
      activeBodyId: activate ? variant.id : activeId,
    };
    const saved = await api.putRequest(collection.id, record);
    return variantReport(saved, request_id, { saved_body: name, added: !existing });
  });

  tool('set_active_body', {
    title: 'Set the active body',
    description:
      'Choose which stored body the request sends from now on (a saved change; run_saved_request ' +
      'body_variant tries one once).',
    inputSchema: { collection_id: z.string(), request_id: z.string(), name: z.string() },
  }, async ({ collection_id, request_id, name }) => {
    const { collection, request } = await httpRequestIn(collection_id, request_id);
    const { bodies } = bodyVariants(request);
    const target = requireVariant(request, bodies, name);
    const saved = await api.putRequest(collection.id, { ...request, bodies, activeBodyId: target.id });
    return variantReport(saved, request_id, { activated: name });
  });

  tool('delete_body_variant', {
    title: 'Delete a body variant',
    description:
      'Remove one named body from a request. The last one cannot go (clear it with save_request); ' +
      'removing the active one activates the first left.',
    inputSchema: { collection_id: z.string(), request_id: z.string(), name: z.string() },
  }, async ({ collection_id, request_id, name }) => {
    const { collection, request } = await httpRequestIn(collection_id, request_id);
    const { bodies, activeId } = bodyVariants(request);
    const target = requireVariant(request, bodies, name);
    if (bodies.length === 1) {
      throw new Error(`"${name}" is the only body on "${request.name}" — a request keeps one. Clear its content with save_request instead.`);
    }
    const next = bodies.filter((b) => b.id !== target.id);
    const record: HttpRequest = {
      ...request,
      bodies: next,
      activeBodyId: activeId === target.id ? next[0]!.id : activeId,
    };
    const saved = await api.putRequest(collection.id, record);
    return variantReport(saved, request_id, { deleted_body: name });
  });

  tool('save_shell_test', {
    title: 'Save a shell test',
    description:
      'Add (no request_id) or update (request_id) a test that runs a shell command: name, command, ' +
      'cwd, timeout_ms, folder_id, vars, script; omitted fields keep their value. {{vars}} in ' +
      'command and cwd resolve from the environment, then the test\'s own vars. See the instructions ' +
      'on shell steps and scripts.',
    inputSchema: {
      collection_id: z.string(),
      test: z.object({
        request_id: z.string().optional(),
        name: z.string(),
        command: z.string().optional(),
        // Where to run it. Empty means the backend's own working directory.
        cwd: z.string().optional(),
        timeout_ms: z.number().int().positive().optional(),
        folder_id: z.string().optional(),
        vars: z.record(z.string(), varValue).optional(),
        // Runs after the command: sh.exitCode / sh.stdout / sh.stderr, plus the
        // same res a request's script gets (res.status is the exit code,
        // res.body is stdout) and env.set to keep a value.
        script: z.string().optional(),
      }),
    },
  }, async ({ collection_id, test }) => {
    const c = await requireCollection(collection_id);
    if (test.folder_id) requireFolder(c, test.folder_id);

    const prev = test.request_id
      ? (c.requests || []).find((x) => x.id === test.request_id) || null
      : null;
    if (prev && prev.kind !== 'shell') {
      throw new Error(
        `Request "${test.request_id}" in "${c.name}" is an HTTP request, not a shell test — `
        + 'save it with save_request, or leave request_id off to create a new shell test.',
      );
    }

    const keep = <T>(given: T | undefined, was: T | undefined, fallback: T | undefined) =>
      (given !== undefined ? given : (prev ? was : fallback));
    const record: ShellRequest = {
      ...prev,
      id: test.request_id || newId(),
      kind: 'shell',
      name: test.name,
      command: keep(test.command, prev ? prev.command : undefined, '')!,
      cwd: keep(test.cwd, prev ? prev.cwd : undefined, ''),
      timeout: keep(test.timeout_ms, prev ? prev.timeout : undefined, undefined),
      folderId: keep(test.folder_id, prev ? prev.folderId : undefined, null) || null,
      // Saved tests are opened in the UI, so they keep the trailing empty row
      // an editable list expects.
      vars: test.vars !== undefined
        ? await varsToRows(test.vars, { trailingBlank: true })
        : (prev ? prev.vars || [] : []),
      script: keep(test.script, prev ? prev.script : undefined, ''),
    };

    const saved = await api.putRequest(c.id, record);
    return { collection_id: saved.id, request_id: record.id, test: record };
  });

  tool('delete_request', {
    title: 'Delete a request',
    description:
      'Delete a saved request or shell test from a collection. used_by_flows lists the flow steps ' +
      'that pointed at it.',
    inputSchema: { collection_id: z.string(), request_id: z.string() },
  }, async ({ collection_id, request_id }) => {
    const c = await requireCollection(collection_id);
    const target = requireRequest(c, request_id);
    const saved = await api.deleteRequest(c.id, target.id);
    const flows = await api.listFlows();
    const usedBy = flows.flatMap((f) => (f.steps || [])
      .filter((s) => s.collectionId === c.id && s.requestId === target.id)
      .map((s) => ({ flow_id: f.id, flow: f.name, step_id: s.id, step: s.name })));
    return {
      collection_id: saved.id,
      deleted_request_id: target.id,
      name: target.name,
      request_count: (saved.requests || []).length,
      used_by_flows: usedBy,
    };
  });
}
