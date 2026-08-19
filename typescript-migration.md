# TypeScript Migration Plan

> **Status: done.** This plan was carried out in this directory — every source
> file here is TypeScript, all three packages pass `tsc --noEmit`, and the
> server suite passes 200/200, the same 200 the JavaScript original passes.
> What follows is the reasoning the conversion was made on, kept as a record of
> why things are arranged the way they are. The "Deferred decisions" at the end
> are still open.

Plan for converting testing-tool (self-hosted Postman replacement:
Express server + React/Vite client + MCP server) from JavaScript to TypeScript.

Written against the codebase as of 2026-08-18. Line counts below are from that
snapshot — re-measure before trusting the estimates.

## Current shape

39 source files, 10,691 lines, excluding `node_modules` and `dist`.

| Area | Lines | Module system | Build step today |
|---|---:|---|---|
| `server/` source (7 files) | 2,880 | CommonJS | none — `node --watch server/index.js` |
| `server/` tests (6 files) | 1,545 | CommonJS | none — `node --test server/` |
| `client/` (20 `.jsx` + 3 `.js`) | 4,976 | ESM | Vite |
| `mcp/` (2 files) | 1,290 | ESM | none — `node mcp/server.js` |

Dependencies are thin: `express` on the server, `react` + `react-dom` on the
client, `@modelcontextprotocol/sdk` + `zod` in MCP. Nothing here has awkward or
missing type definitions.

Largest single files, which is where the time goes:
`mcp/server.js` (1,225), `client/src/App.jsx` (879), `client/src/components/FlowPanel.jsx` (742),
`server/index.js` (611), `server/flow.js` (581), `client/src/components/Sidebar.jsx` (577),
`server/runner.js` (486), `server/store.js` (446), `client/src/util.js` (406).

## What makes this cheap

1. **Node 26 strips types natively.** Rename `server/index.js` → `.ts`, and
   `node --watch server/index.ts` runs it directly. `node --test server/` keeps
   working on `.ts` test files. The server needs no bundler, no `ts-node`, no
   `dist/`, no change to `npm start`. Types are erased at load; they are never
   checked at runtime, so `tsc --noEmit` stays a separate deliberate step.
2. **Vite strips client types via esbuild.** `.jsx` → `.tsx` costs nothing at
   dev time. Same caveat: esbuild erases, it does not check.
3. **MCP already declares its input schemas in zod.** Every tool in
   `mcp/server.js` has an `inputSchema` built from `z.*`. `z.infer<typeof schema>`
   turns those into types for free, which makes the largest file in the repo the
   cheapest one to convert.

## What actually costs time

**The domain model, not the syntax.** Everything persists as untyped JSON on
disk (`data/collections/*.json`, `data/environments/*.json`, `data/flows/*.json`)
and is read back through `JSON.parse` with no validation. The evidence:

- 71 `JSON.parse` call sites
- 283 `Object.keys` / `Object.entries` loops
- **1,218 optional chains (`?.`)**

That last number is the real finding. The code defends constantly against shapes
it cannot name. Naming them is both the bulk of the work and the entire payoff.
Expect a meaningful share of those `?.` to turn out to be wrong in one direction
or the other — either guarding something that is always present, or guarding one
level too shallow. Each is a small judgement call, and they do not batch well.

**Module system split.** `server/` is CommonJS (`require`, `__dirname`) while
`client/` and `mcp/` are ESM. TypeScript compiles CJS fine, but the server is
worth flipping to ESM during the move. That touches all 13 server files at once
and is the one change that cannot be done incrementally, so do it first and
commit it on its own, before any types exist, while the diff is still reviewable
as pure mechanics.

Note `store.js` uses `__dirname` for `DATA_DIR`; under ESM that becomes
`import.meta.dirname`.

## Suggested order

Each step should build, pass `node --test server/`, and be committable alone.

1. **Server CJS → ESM.** No types yet. `require` → `import`,
   `module.exports` → `export`, `__dirname` → `import.meta.dirname`, add
   `"type": "module"` to the root `package.json`. Verify the 6 test files still
   pass. Commit.
2. **Add tooling.** `typescript` as a dev dependency, one `tsconfig.json` per
   area (server, client, mcp) or one root config with project references. Add an
   explicit `npm run typecheck` → `tsc --noEmit`. Do not wire type checking into
   `npm start` or `npm run dev`; the whole benefit of native stripping is that
   the run path stays instant.
3. **Write `types.ts` first, before renaming anything.** The shared domain:
   `Collection`, `Folder`, `Request`, `Environment`, `Flow`, `FlowFolder`,
   `Step`, plus the stored-file shapes `store.ts` reads and writes. Derive these
   by reading the actual JSON in `data/` alongside the code — the files on disk
   are the real schema, and where code and data disagree, the data wins.
   This file is the deliverable everything else leans on; get it right before
   it has 30 dependents.
4. **`server/store.ts`.** The narrowest waist in the system — every persisted
   shape passes through it. Typing this one file pushes inferred types outward
   into `resolve`, `flow`, `runner`, and `index` before those are even converted.
5. **Rest of `server/`,** in dependency order: `resolve` → `postman` → `shell`
   → `runner` → `flow` → `index`.
6. **`server/*.test.ts`.** Converting tests last means they stay a fixed
   reference point while the source moves under them.
7. **`mcp/`.** Replace hand-written parameter types with `z.infer` off the
   existing `inputSchema` objects. Mostly mechanical given step 3.
8. **`client/`,** leaves first: `Icons`, `HelpTip`, `KeyValueEditor`, `VarField`,
   then the editors and panels, then `App.tsx` last. `client/src/util.ts`
   (the `substitute` / `buildUrl` variable machinery) should go early — MCP
   ported that logic, so the two want the same types.

## Effort

- **Mechanical pass** — renames, tsconfig, `any` wherever it resists, compiles
  clean: roughly a day. Produces little lasting value on its own.
- **A migration worth having** — real domain types, `?.` chains resolved
  honestly, `strict` on: a few days, nearly all of it in steps 3–5.

Do not stop after the mechanical pass. A codebase full of `any` carries the
cost of TypeScript with none of the benefit, and the momentum to go back and
finish it rarely arrives.

## Cheaper alternative, if the full migration is not worth it now

Keep the `.js` extensions. Add a single `types.d.ts` describing the stored
shapes, then put `// @ts-check` and JSDoc annotations at the top of the four
files where the shapes actually matter: `store.js`, `resolve.js`, `flow.js`,
`runner.js`.

This gives editor autocomplete and real error checking across the server's core
with zero change to how anything runs, no new dependency, and no rename. If it
proves its worth after a week, the full conversion is then mostly renaming —
step 3 above is already done, which is the expensive part.

## Deferred decisions

- **Runtime validation at the disk boundary.** Types vanish at runtime, so a
  hand-edited or older-format JSON file still enters the system unchecked.
  `zod` is already a dependency in `mcp/`; parsing in `store.ts` on read would
  close the gap. Worth doing, but it is a behaviour change (it can start
  rejecting files that load fine today) and belongs in its own commit after the
  migration, not inside it.
- **`strict` from day one vs. tightening later.** Starting strict is more
  upfront friction but avoids a second pass over all 39 files. Recommended,
  given the codebase is small enough to absorb it.
- **Whether the client needs its own tsconfig** or can share a root one with
  project references. Only matters if the client is ever split out separately.
