# API Test

A lightweight, self-hosted, Postman-like tool for testing HTTP APIs — runs in the
browser, straight from Node.js.

## Features

- Build and send requests: methods (GET/POST/PUT/PATCH/DELETE/…), query params,
  custom headers, and JSON/text/`multipart/form-data` bodies (files included).
- **Body variants**: keep multiple named bodies per request (e.g. "valid",
  "missing field", "bad format") and switch between them — no more commenting
  payloads in and out.
- **Server-side proxy** so requests are not blocked by browser CORS.
- **Collections and folders**: save requests into a collection, grouped in a
  folder tree. Each collection is a single JSON file under `data/collections/`.
- **`{{dy_url}}`**: folder names double as URL path segments, so the folder tree
  mirrors the API's route tree — see below.
- **Environments**: define variables and reference them anywhere with
  `{{variable}}` (URL, params, headers, body) — highlighted inline, hover to
  see the resolved value.
- **Collection auth**: a default `Bearer {{token}}` or API-key header applied to
  every request that does not set that header itself.
- **Post-response scripts**: run JS after each response, e.g.
  `env.set('token', res.json().access_token)` to capture a login token into
  the active environment.
- **Flows**: chain saved or typed-in requests to exercise a whole feature end to end
  (login → create → read → update → delete), passing values between steps and
  asserting what comes back — see below.
- **Postman import**: v2.x collection and environment exports.

## `{{dy_url}}` — URLs from the folder tree

A request URL of `{{dy_url}}/login/` in folder `auth` resolves to
`<base_url>/auth/login/`; nesting accumulates. Because folder names *are* the
path segments, renaming a folder moves every route inside it, and pointing the
collection at another host is one edit rather than one per request.

`{{base_url}}` itself resolves most-specific-first:

1. the collection's own base URL (may contain `{{vars}}`)
2. the active environment's `base_url` variable
3. the built-in default, `http://localhost:8000`

A URL without a `{{dy_url}}` token is left alone, so folders only affect
requests that opt in, and a full `http(s)://` URL is always sent verbatim.

## Flows

A flow is an ordered list of requests run together. A step either points at a
saved request (**Saved**) or carries one typed into the step itself
(**Direct** — method, URL, headers, query params and a body), for an endpoint
not worth filing in a collection. A direct step may still name a collection,
which lends it only that collection's base URL and default auth; it has no
folder, so `{{dy_url}}` there is just `{{base_url}}`.

Either way, each step can:

- **extract** a value into a run variable later steps use as `{{var}}`
  (e.g. `data.id` → `user_id`)
- **assert** on `status` / `body` / `header` / `cookie` / `time` with
  `eq`, `neq`, `exists`, `missing`, `contains`, `matches`, `lt`, `gt`
- run a **script** for checks the rules above cannot express, via
  `expect(cond, message)`
- be marked **always**, so a teardown step still runs after an earlier failure
  and a failed run does not leave its rows behind

A failure stops the chain — the steps after it were going to act on an id that
was never created. Run variables (including a token a login script saves with
`env.set`) live only for the run and never touch the stored environment.

## Tech stack

- Frontend: React + Vite
- Backend: Node.js + Express, in TypeScript (also serves the built frontend in production)
- Storage: plain JSON files on disk (`data/`)

## Getting started

Requires Node.js 22.18+ — the sources are TypeScript and are run directly,
relying on node's built-in type stripping rather than a build step.

```bash
npm run install:all   # install server + client deps
npm run dev           # server on :3000, Vite dev server on :5173
```

Open <http://localhost:5173> for development (it proxies `/api` to the server).

### Production build

```bash
npm run build   # builds client into client/dist
npm start       # serves API + frontend on :3000
```

Then open <http://localhost:3000>.

### Tests

```bash
npm test
```

Node's built-in runner, no extra dependencies. Covers URL/variable resolution,
the Postman import, and the flow runner (including a real HTTP round trip).

## A note on exposure

The server binds `127.0.0.1` by default, and it should stay that way: a request
carries a post-response script that the server executes, and a shell test (or a
flow's shell step) is a command line it runs outright, so anyone who can reach
the port can run code as this process. The MCP endpoint binds loopback for the
same reason — its tools drive that same backend. `HOST` and `MCP_HTTP_HOST`
override the bind addresses; there is no good reason to widen either. Keep both
off the LAN.

## Data layout

```
data/
  collections/<id>.json   # { id, name, baseUrl, auth, folders: [...], requests: [...] }
  environments/<id>.json  # { id, name, variables: {...}, disabled: [...] }
  flows/<id>.json         # { id, name, group, environmentId, steps: [...] }
  base_urls.json          # the base-URL pick-list
  uploads/                # bytes + metadata for form-data file fields
```

Override the storage location with the `DATA_DIR` environment variable
(defaults to `./data`).

## MCP server

`mcp/server.ts` exposes the collections / environments / send tools to MCP
clients (Claude Code, IDEs). It is a thin client of the HTTP backend, so the
backend must be running. It supports two transports:

- **Streamable HTTP** (set `MCP_HTTP_PORT`) — a long-lived service clients reach
  by URL. This is the recommended, always-on setup.
- **stdio** (default) — the client spawns the process per session.

### Always-on HTTP server (recommended)

`npm run dev` starts it alongside the backend and the client, over Streamable
HTTP on `127.0.0.1:8765`. Point any project's `.mcp.json` (or IDE MCP config) at
the URL — one endpoint, nothing to launch per session:

```json
{
  "mcpServers": {
    "api-test": {
      "type": "http",
      "url": "http://localhost:8765/mcp"
    }
  }
}
```

To run only the MCP server (the backend still has to be up):

```bash
npm run dev:mcp
```

Notes:
- It binds `127.0.0.1` on its own; `MCP_HTTP_HOST` overrides that — keep it off
  the LAN.
- Requests carrying a browser `Origin` other than localhost are refused, so a web
  page you happen to have open cannot drive the tools over your loopback.
- `API_TEST_URL` points it at the backend (default `http://localhost:3000`).

### Alternative: stdio

If you prefer stdio — the client spawns the process per session, nothing left
running — give it the absolute path to `mcp/server.ts`:

```json
{
  "mcpServers": {
    "api-test": {
      "command": "node",
      "args": ["/absolute/path/to/api_test/mcp/server.ts"]
    }
  }
}
```

Install its deps once with `npm --prefix mcp install`. The backend still has to
be running either way — this server is only a client of it.

