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
    }));
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
