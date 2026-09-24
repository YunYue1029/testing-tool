// Flows: steps chained into a feature test, the folder tree they are filed
// in, and running one.
import { z } from 'zod';
import { api } from '../api.ts';
import { folderPath } from '../../server/resolve.ts';
import { clipped, flowOut, inlineFromMcp, inlineIn, requireEnv, varsToRows, varValue } from '../shape.ts';
import type { Tool } from '../server.ts';

export function register(tool: Tool): void {
  tool('list_flows', {
    title: 'List flows',
    description:
      'List flows (flow_id, name, description, folder, environment, step_count) and the flow folder ' +
      'tree they are filed in.',
    inputSchema: {},
  }, async () => {
    const [list, folders] = await Promise.all([api.listFlows(), api.listFlowFolders()]);
    // Pinned environments are named the way save_flow takes them; the listing
    // is skipped when no flow is pinned.
    const envs = list.some((f) => f.environmentId) ? await api.listEnvironments() : [];
    return {
      folders: folders.map((f) => ({
        folder_id: f.id,
        name: f.name,
        parent_folder_id: f.parentId || null,
        path: folderPath(folders, f.id),
      })),
      flows: list.map((f) => {
        const env = f.environmentId ? envs.find((e) => e.id === f.environmentId) : undefined;
        return {
          flow_id: f.id,
          name: f.name,
          description: f.description || '',
          folder_id: f.folderId || null,
          folder: f.folderId ? folderPath(folders, f.folderId) : null,
          environment: env ? env.name : null,
          // A count, not the list: get_flow has the steps themselves.
          step_count: (f.steps || []).length,
          updated_at: f.updatedAt,
        };
      }),
    };
  });

  tool('create_flow_folder', {
    title: 'Create a flow folder',
    description:
      'Create a folder to file flows under (nest with parent_folder_id). Organisation only, no URL ' +
      'meaning — name it after the feature the flows cover.',
    inputSchema: {
      name: z.string(),
      parent_folder_id: z.string().optional(),
    },
  }, async ({ name, parent_folder_id }) => {
    const { folder, folders } = await api.createFlowFolder({
      name, parentId: parent_folder_id || null,
    });
    return { folder_id: folder.id, name: folder.name, path: folderPath(folders, folder.id) };
  });

  tool('get_flow', {
    title: 'Get a flow',
    description:
      'One flow in save_flow\'s input shape: edit what comes back and pass it to save_flow, keeping ' +
      'each step\'s id.',
    inputSchema: { flow_id: z.string() },
  }, async ({ flow_id }) => {
    const f = await api.getFlow(flow_id);
    if (!f) throw new Error(`Flow "${flow_id}" not found`);
    // The listing is only needed to name the pinned environment; unpinned,
    // varsOut fetches it itself when a var varies by environment.
    const envs = f.environmentId ? await api.listEnvironments() : undefined;
    return flowOut(f, envs);
  });

  tool('save_flow', {
    title: 'Save a flow',
    description:
      'Create (no flow_id) or update (flow_id) a flow: name, description, folder_id, environment, ' +
      'vars, shell_session, shell_cwd and steps — each mode "inline" ' +
      '(inline:{method,url,headers,params,body_type,body,auth}), "shell" (command, cwd, timeout_ms) ' +
      'or "saved" (collection_id + request_id), with extract, assert, when, script, always, ' +
      'enabled, overrides. steps always replace the stored list whole; on update every other ' +
      'omitted field is kept (omitting folder_id leaves a new flow at the root). environment pins ' +
      'every run to one environment — leave it out unless the flow only makes sense against one ' +
      'deployment. See the instructions for how to write steps.',
    inputSchema: {
      flow_id: z.string().optional(),
      name: z.string(),
      description: z.string().optional(),
      folder_id: z.string().optional(),
      environment: z.string().optional(),
      vars: z.record(z.string(), varValue).optional(),
      // What the flow's shell steps run in, for all of them at once.
      shell_session: z.boolean().optional(),
      shell_cwd: z.string().optional(),
      steps: z.array(z.object({
        // The id get_flow reported, so a step stays the same step across a save.
        // Left out, the store mints a fresh one, stranding whatever still points
        // at the old id — a single-step run, or a step opened in the UI.
        id: z.string().optional(),
        name: z.string().optional(),
        mode: z.enum(['saved', 'inline', 'shell']).optional(),
        collection_id: z.string().optional(),
        request_id: z.string().optional(),
        // Same auth a saved request has. A login typed into a flow needs
        // {"type":"none"} for exactly the reason one saved does.
        inline: inlineIn.optional(),
        // Shell mode. {{vars}} in the command are resolved at run time, so a
        // command can go looking for what an earlier step captured. `cwd` is a
        // cd in the shell the flow shares, so the steps after this one carry on
        // from there unless they name a directory of their own.
        command: z.string().optional(),
        cwd: z.string().optional(),
        timeout_ms: z.number().optional(),
        enabled: z.boolean().optional(),
        always: z.boolean().optional(),
        when: z.array(z.object({
          var: z.string(),
          op: z.enum(['eq', 'neq', 'exists', 'missing', 'contains', 'matches', 'lt', 'gt']).optional(),
          value: z.string().optional(),
        })).optional(),
        extract: z.array(z.object({
          var: z.string(),
          from: z.enum([
            'body', 'header', 'cookie', 'status', 'time',
            'stdout', 'stderr', 'exit_code',
          ]).optional(),
          path: z.string().optional(),
        })).optional(),
        assert: z.array(z.object({
          source: z.enum([
            'status', 'body', 'header', 'cookie', 'time',
            'stdout', 'stderr', 'exit_code',
          ]),
          path: z.string().optional(),
          op: z.enum(['eq', 'neq', 'exists', 'missing', 'contains', 'matches', 'lt', 'gt']).optional(),
          value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        })).optional(),
        script: z.string().optional(),
        overrides: z.object({
          url: z.string().optional(),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().optional(),
        }).optional(),
      })),
    },
  }, async ({
    flow_id, name, description, folder_id, environment, vars, shell_session, shell_cwd, steps,
  }) => {
    // An update that says nothing about a field keeps it — editing a step
    // should not quietly wipe the inputs the flow runs with, unpin it or move
    // it to the root. Only the steps are always replaced whole.
    const prev = flow_id ? await api.getFlow(flow_id) : null;
    if (flow_id && !prev) throw new Error(`Flow "${flow_id}" not found`);
    let environmentId: string | null = prev ? prev.environmentId : null;
    if (environment !== undefined) {
      environmentId = environment ? (await requireEnv(environment)).id : null;
    }
    const record = {
      name,
      description: description !== undefined ? description : (prev ? prev.description || '' : ''),
      folderId: folder_id !== undefined ? (folder_id || null) : (prev ? prev.folderId || null : null),
      environmentId,
      vars: vars !== undefined
        ? await varsToRows(vars)
        : (prev ? prev.vars || [] : []),
      shell: {
        session: shell_session !== undefined
          ? shell_session
          : (!prev || !prev.shell || prev.shell.session !== false),
        cwd: shell_cwd !== undefined ? shell_cwd : ((prev && prev.shell && prev.shell.cwd) || ''),
      },
      steps: (steps || []).map((s, i) => {
        // The step says which it is, but a step carrying only an inline request
        // clearly means inline — making callers state it twice is a trap.
        const mode = s.mode
          || (s.command ? 'shell' : (s.inline && !s.request_id ? 'inline' : 'saved'));
        const where = `Step ${i + 1}${s.name ? ` ("${s.name}")` : ''}`;
        if (mode === 'inline' && !s.inline) {
          throw new Error(`${where} is inline but has no inline request — give it inline:{url:…}`);
        }
        if (mode === 'shell' && !(s.command || '').trim()) {
          throw new Error(`${where} is a shell step but has no command — give it command:"…"`);
        }
        if (mode === 'saved' && !(s.collection_id && s.request_id)) {
          throw new Error(
            `${where} needs collection_id and request_id, mode:"inline" with an inline request, `
            + 'or mode:"shell" with a command',
          );
        }
        return {
          id: s.id || undefined,
          name: s.name || '',
          mode,
          collectionId: s.collection_id || null,
          requestId: s.request_id || null,
          request: s.inline && inlineFromMcp(s.inline),
          command: s.command || '',
          cwd: s.cwd || '',
          timeout: s.timeout_ms,
          enabled: s.enabled !== false,
          always: s.always === true,
          when: s.when || [],
          extract: s.extract || [],
          assert: s.assert || [],
          script: s.script || '',
          overrides: s.overrides,
        };
      }),
    };
    const saved = flow_id
      ? await api.updateFlow(flow_id, { ...record, id: flow_id })
      : await api.createFlow(record);
    return {
      flow_id: saved.id, name: saved.name, folder_id: saved.folderId || null,
      steps: saved.steps.length,
    };
  });

  tool('run_flow', {
    title: 'Run a flow',
    description:
      'Run every step in order: passing steps reported as one line each, failures with the ' +
      'assertion that broke, what was sent and the response body. environment overrides the flow\'s ' +
      'pinned one; max_body_chars raises the body cap.',
    inputSchema: {
      flow_id: z.string(),
      environment: z.string().optional(),
      max_body_chars: z.number().int().positive().optional(),
    },
  }, async ({ flow_id, environment, max_body_chars }) => {
    const report = await api.runFlow(flow_id, { environment });
    if (!report.steps.length) {
      return { flow: report.name, ok: true, note: 'This flow has no steps yet — nothing ran.' };
    }
    // Compact on purpose: a full report of every passing step's response would
    // crowd out the reason the run actually failed.
    return {
      flow: report.name,
      ok: report.ok,
      duration_ms: report.durationMs,
      steps: report.steps.map((s) => {
        if (s.skipped) return `- ${s.name}: skipped (${s.skipped})`;
        // A shell step has no status to report; its exit code is the verdict.
        const verdict = s.mode === 'shell' ? `exit ${s.exitCode}` : s.status;
        if (s.ok) return `PASS ${s.name}: ${verdict} (${s.timeMs}ms)`;
        return {
          step: s.name,
          status: verdict,
          failed: (s.assertions || []).filter((a) => !a.ok).map((a) => a.detail),
          // What the step sent, with this run's variables resolved into it — a
          // step usually fails because the call was not the one intended, and
          // the saved request cannot show that: an id captured two steps back
          // only exists in the url and body that actually went out.
          ...(s.mode === 'shell'
            ? { sent: s.command }
            : s.request
              ? {
                sent: `${s.request.method} ${s.request.url}`,
                ...(s.request.body ? clipped('sent_body', s.request.body, max_body_chars) : {}),
              }
              : {}),
          ...(s.error ? { error: s.error } : {}),
          ...(s.script ? { script_error: s.script.error } : {}),
          // Where a failing command explains itself — and, when the shell the
          // run was sharing had died, that this one started from nothing.
          ...(s.shell && s.shell.stderr ? clipped('stderr', s.shell.stderr, max_body_chars) : {}),
          ...(s.freshShell ? { fresh_shell: true } : {}),
          // The report carries the whole body for every step; a failure report
          // here wants the head of it, not twenty thousand characters.
          ...(s.response && s.response.body ? clipped('body', s.response.body, max_body_chars) : {}),
        };
      }),
      vars: report.vars,
    };
  });

  tool('delete_flow', {
    title: 'Delete a flow',
    description:
      'Delete a flow and its steps. The saved requests it pointed at are not touched.',
    inputSchema: { flow_id: z.string() },
  }, async ({ flow_id }) => {
    const f = await api.getFlow(flow_id);
    if (!f) throw new Error(`Flow "${flow_id}" not found`);
    const res = await api.deleteFlow(f.id);
    return { deleted_flow_id: f.id, name: f.name, steps: (f.steps || []).length, ok: res.ok };
  });

  tool('delete_flow_folder', {
    title: 'Delete a flow folder',
    description:
      'Delete a flow folder with the folders nested inside it and every flow in any of them. To ' +
      'keep the flows, move them out first with save_flow folder_id.',
    inputSchema: { folder_id: z.string() },
  }, async ({ folder_id }) => {
    const before = await api.listFlowFolders();
    const target = before.find((f) => f.id === folder_id);
    if (!target) throw new Error(`Flow folder "${folder_id}" not found`);
    const flowsBefore = await api.listFlows();
    const out = await api.deleteFlowFolder(folder_id);
    const gone = new Set(out.deletedFlows || []);
    return {
      deleted_folder_id: folder_id,
      name: target.name,
      path: folderPath(before, folder_id),
      deleted_folders: before
        .filter((f) => !(out.folders || []).some((g) => g.id === f.id))
        .map((f) => ({ folder_id: f.id, name: f.name })),
      deleted_flows: flowsBefore
        .filter((f) => gone.has(f.id))
        .map((f) => ({ flow_id: f.id, name: f.name })),
    };
  });
}
