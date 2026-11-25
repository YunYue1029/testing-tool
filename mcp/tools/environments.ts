// Environments: the {{vars}} shared across requests, by name or id.
import { z } from 'zod';
import { api } from '../api.ts';
import { requireEnv } from '../shape.ts';
import type { Tool } from '../server.ts';

export function register(tool: Tool): void {
  tool('list_environments', {
    title: 'List environments',
    description:
      'List environments with their variables and disabled keys.',
    inputSchema: {},
  }, async () => {
    const envs = await api.listEnvironments();
    return envs.map((e) => ({
      environment_id: e.id,
      name: e.name,
      variables: e.variables || {},
      disabled: e.disabled || [],
      is_default: !!e.isDefault,
    }));
  });

  tool('save_environment', {
    title: 'Create or update an environment',
    description:
      'Create (no environment) or update (environment, by name or id) an environment — everything ' +
      'the Environments editor can change. name renames it. variables is merged into the existing ' +
      'ones (a key already there is overwritten); remove_variables deletes keys. disabled replaces ' +
      'the list of keys that keep their value but are skipped in {{var}} substitution. is_default ' +
      'true makes it the default (the one request/flow vars fall back to), unmarking the previous ' +
      'one; false unmarks it. An omitted field is kept. A new environment also starts with every ' +
      'collection\'s base_url variable, empty.',
    inputSchema: {
      environment: z.string().optional(),
      name: z.string().optional(),
      variables: z.record(z.string(), z.string()).optional(),
      remove_variables: z.array(z.string()).optional(),
      disabled: z.array(z.string()).optional(),
      is_default: z.boolean().optional(),
    },
  }, async ({ environment, name, variables, remove_variables, disabled, is_default }) => {
    const prev = environment ? await requireEnv(environment) : undefined;
    if (!prev && !name) throw new Error('name is required to create an environment');
    const merged: Record<string, string> = { ...(prev?.variables || {}), ...(variables || {}) };
    for (const key of remove_variables || []) delete merged[key];
    // A removed key has no value left to be switched off.
    const keep = disabled ?? prev?.disabled ?? [];
    const input = {
      name: name ?? prev?.name,
      variables: merged,
      disabled: keep.filter((k) => k in merged),
      ...(is_default === undefined ? {} : { isDefault: is_default }),
    };
    const saved = prev
      ? await api.updateEnvironment(prev.id, input)
      : await api.createEnvironment(input);
    return {
      environment_id: saved.id,
      name: saved.name,
      variables: saved.variables,
      disabled: saved.disabled,
      is_default: !!saved.isDefault,
      created: !prev,
    };
  });

  tool('set_env_var', {
    title: 'Set an environment variable',
    description:
      'Create or update one variable in an environment — e.g. store a token so later requests ' +
      'resolve {{token}}.',
    inputSchema: { environment: z.string(), key: z.string(), value: z.string() },
  }, async ({ environment, key, value }) => {
    const env = await requireEnv(environment);
    const variables = { ...(env.variables || {}), [key]: value };
    const saved = await api.updateEnvironment(env.id, { ...env, variables });
    return { environment_id: saved.id, name: saved.name, variables: saved.variables };
  });

  tool('delete_environment', {
    title: 'Delete an environment',
    description:
      'Delete an environment with every variable in it. Requests are not touched: their {{vars}} ' +
      'simply stop resolving.',
    inputSchema: { environment: z.string() },
  }, async ({ environment }) => {
    const env = await requireEnv(environment);
    const res = await api.deleteEnvironment(env.id);
    return {
      deleted_environment_id: env.id,
      name: env.name,
      deleted_variables: Object.keys(env.variables || {}).length,
      ok: res.ok,
    };
  });
}
