// The Streamable HTTP transport: a long-lived service clients reach by URL,
// one server instance per session.
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { api } from './api.ts';

// A browser sends Origin on every cross-origin fetch; a real MCP client sends
// none at all. That asymmetry is the whole defence here: a page on evil.com
// cannot drive these tools even after pointing its own DNS at 127.0.0.1,
// because the Origin it must send still says evil.com. Worth having because
// reaching this port means reaching every tool, and the tools reach a backend
// that executes post-response scripts.
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

// MCP messages are small — a saved request carrying a body is the largest thing
// that passes through. Without a ceiling one POST can grow the process until it
// dies.
const MAX_BODY = 4 * 1024 * 1024;

// Long-lived Streamable HTTP service. Sessions are tracked by the
// mcp-session-id header; each new session gets its own server instance.
export function startHttp(port: number, createServer: () => McpServer): void {
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  // When each session was last spoken to. A client that goes away without a
  // DELETE leaves its session behind for as long as this process runs, and a
  // day of restarted IDEs adds up.
  const lastSeen: Record<string, number> = {};
  const touch = (sid: string | undefined) => { if (sid) lastSeen[sid] = Date.now(); };

  // A session id this process does not know is almost always one an earlier
  // run of it issued: sessions live in memory here, so restarting — which
  // `npm run dev` does on every edit under mcp/ — takes all of them with it.
  // 404 is what says that, and the protocol makes it the client's cue to open a
  // new session with a fresh initialize. A 400 reads as "you sent nonsense"
  // instead, which is why a restart used to leave the client disconnected until
  // somebody reconnected it by hand.
  function noSuchSession(res: ServerResponse): void {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Session not found — this server has restarted. Initialize a new session.',
      },
      id: null,
    }));
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;
    if (sid && transports[sid]) {
      transport = transports[sid]!;
      touch(sid);
    } else if (isInitializeRequest(body)) {
      // Whatever session id came with it: a client asking to initialize is
      // asking for a new session, and refusing it over a stale header would
      // leave it with no way back in.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { transports[id] = transport; touch(id); },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
          delete lastSeen[transport.sessionId];
        }
      };
      await createServer().connect(transport);
    } else if (sid) {
      noSuchSession(res);
      return;
    } else {
      // No session and not an initialize: the client skipped the handshake,
      // which is a different mistake and not one a reconnect fixes.
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: initialize first, or send a session ID' },
        id: null,
      }));
      return;
    }
    await transport.handleRequest(req, res, body);
  }

  async function handleSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (sid && transports[sid]) {
      touch(sid);
      await transports[sid]!.handleRequest(req, res);
      return;
    }
    // Same distinction as above: a stale id is a restart to recover from, a
    // missing one is a client that never opened a session at all.
    if (sid) {
      noSuchSession(res);
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Bad Request: missing session ID' },
      id: null,
    }));
  }

  const httpServer = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && !LOOPBACK_ORIGIN.test(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden origin');
      return;
    }
    const path = (req.url || '').split('?')[0];
    if (path !== '/mcp') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let tooBig = false;
      // Kept as bytes and decoded once at the end: the ceiling is on what is
      // held in memory, which is bytes rather than the UTF-16 units a string's
      // length counts — and a chunk boundary can fall inside a multi-byte
      // character, which per-chunk toString() would turn into U+FFFD.
      req.on('data', (c: Buffer) => {
        if (tooBig) return;
        bytes += c.length;
        if (bytes > MAX_BODY) {
          tooBig = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end('{"jsonrpc":"2.0","error":{"code":-32600,"message":"Request too large"},"id":null}');
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return;
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}');
          return;
        }
        handlePost(req, res, body).catch((err) => {
          console.error(err);
          if (!res.headersSent) { res.writeHead(500); res.end(); }
        });
      });
      // The reset we caused by hanging up on an oversized body is not news.
      req.on('error', (err) => { if (!tooBig) console.error(err); });
    } else if (req.method === 'GET' || req.method === 'DELETE') {
      handleSession(req, res).catch((err) => {
        console.error(err);
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      });
    } else {
      res.writeHead(405);
      res.end('Method Not Allowed');
    }
  });

  // Loopback by default — these tools drive the backend, which runs scripts, so
  // reaching this port is as good as a shell here. MCP_HTTP_HOST overrides the
  // bind address; there is no good reason to widen it.
  const host = process.env.MCP_HTTP_HOST || '127.0.0.1';
  httpServer.listen(port, host, () => {
    const shown = host === '0.0.0.0' ? 'localhost' : host;
    console.error(`testing-tool MCP (HTTP) ready on http://${shown}:${port}/mcp (backend: ${api.base})`);
  });

  // Sessions nobody has spoken to for an hour are closed, on a timer that does
  // not by itself keep the process alive.
  const IDLE_MS = 60 * 60 * 1000;
  const sweep = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const [sid, seen] of Object.entries(lastSeen)) {
      if (seen >= cutoff) continue;
      const t = transports[sid];
      if (t) void t.close().catch(() => {});
      else delete lastSeen[sid];
    }
  }, 10 * 60 * 1000);
  sweep.unref();

  // `node --watch` restarts this process with SIGTERM on every edit under
  // mcp/. Closing the transports first ends each session's open stream
  // deliberately rather than by a reset, and closing the listener gives the
  // port back at once instead of when the last keep-alive connection times
  // out. A connection that will not drain must not keep the process here.
  const shutdown = () => {
    clearInterval(sweep);
    Promise.all(Object.values(transports).map((t) => t.close().catch(() => {})))
      .then(() => {
        httpServer.close(() => process.exit(0));
        httpServer.closeAllConnections();
      });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
