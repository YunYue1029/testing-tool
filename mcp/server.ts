#!/usr/bin/env node
// MCP server for testing-tool. Talks to the testing-tool HTTP backend and
// exposes it as MCP tools: collections of endpoints and shell tests, flows
// that chain them into feature tests, environments, and sending.
//
// Two transports:
//   - stdio (default): the MCP client spawns this process per session.
//   - Streamable HTTP: set MCP_HTTP_PORT to run as a long-lived service that
//     clients reach by URL (http://host:PORT/mcp). This is what `npm run dev`
//     starts, so any project's .mcp.json can point at the one URL.
//
// NOTE (stdio mode): stdout is the protocol channel — never console.log to it.
//       Use console.error (stderr) for diagnostics.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { api } from './api.ts';
import { startHttp } from './http.ts';
import { INSTRUCTIONS } from './instructions.ts';
import * as collections from './tools/collections.ts';
import * as environments from './tools/environments.ts';
import * as flows from './tools/flows.ts';
import * as requests from './tools/requests.ts';

// What every tool file registers through: a name, its title, description and
// zod input shape, and a handler typed from that shape.
export type Tool = <S extends ZodRawShapeCompat>(
  name: string,
  config: { title: string; description: string; inputSchema: S },
  handler: (args: ShapeOutput<S>) => Promise<unknown>,
) => void;

// ---- result helpers ----
// Compact JSON: a tool result is read by a model, and the indentation of a
// pretty-printed body is tokens spent on nothing.
function ok(data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text' as const, text }] };
}

// Build a fresh MCP server with all tools registered. A factory (rather than a
// singleton) so HTTP mode can create one server per session.
function createServer() {
  const server = new McpServer({ name: 'testing-tool', version: '1.0.0' }, { instructions: INSTRUCTIONS });

  // Register a tool with uniform error handling. The handler's argument type
  // is inferred from the tool's own `inputSchema`, so the zod shape beside each
  // tool is the single definition of what it takes.
  const tool: Tool = <S extends ZodRawShapeCompat>(
    name: string,
    config: { title: string; description: string; inputSchema: S },
    handler: (args: ShapeOutput<S>) => Promise<unknown>,
  ): void => {
    // The SDK types the callback as a conditional on the shape, which stays
    // unresolved for a generic S, so tsc can neither infer this callback's
    // arguments nor accept it as that type once they are written down. It is
    // that type — the shape's output is what the SDK hands a shape's callback
    // — and the assertion says which one, rather than `never`, so a handler
    // taking the wrong arguments still fails at `handler(args)` above it.
    const cb = (async (args: ShapeOutput<S>) => {
      try {
        return ok(await handler(args));
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message || String(err) }],
          isError: true,
        };
      }
    }) as unknown as ToolCallback<S>;
    server.registerTool<ZodRawShapeCompat, S>(name, config, cb);
  };

  collections.register(tool);
  requests.register(tool);
  flows.register(tool);
  environments.register(tool);

  return server;
}

const httpPort = process.env.MCP_HTTP_PORT;
if (httpPort) {
  startHttp(Number(httpPort), createServer);
} else {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`testing-tool MCP server ready over stdio (backend: ${api.base})`);
}
