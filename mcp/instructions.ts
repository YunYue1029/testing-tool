// Usage conventions, delivered to every client via the MCP `instructions`
// field on initialize — so no client-side setup or docs are needed.
export const INSTRUCTIONS = `testing-tool: a self-hosted Postman replacement for testing an API/CRUD backend
under development. Requests are organised as collection -> folders -> requests;
flows chain steps into feature tests; environments hold shared {{vars}}.

{{dy_url}} — dynamic URLs from folder structure (use this well):
- {{dy_url}} expands to {{base_url}} + the request's folder path. Folder
  names ARE URL path segments; nesting accumulates:
    folder "auth",    url "{{dy_url}}/login/"       -> <base>/auth/login/
    folder "api/v1",  url "{{dy_url}}/users"         -> <base>/api/v1/users
    request at collection root, "{{dy_url}}/health"  -> <base>/health
- The folder tree mirrors the route tree: rename a folder and every request
  inside follows; switch base_url and the collection points at another host.
  No per-request URL edits, ever.
- Design folders after route prefixes, one per resource/prefix:
    routes /users, /users/:id            -> folder "users"
    routes /orders/:id/items             -> folder "orders" (url {{dy_url}}/{{order_id}}/items)
    versioned API /api/v1/...            -> nested folders "api" > "v1"
  Inside a folder the url holds ONLY what comes after the folder path —
  "{{dy_url}}/", "{{dy_url}}/{{id}}/", or a short sub-path.
- NEVER repeat the folder name in the url: in folder "auth",
  "{{dy_url}}/auth/login/" gives /auth/auth/login/. A saved url that
  duplicates its folder path is a bug — strip the duplicate.
- Path params are just {{vars}}: "{{dy_url}}/{{user_id}}/" resolves user_id
  from the request's own vars first, then the environment. Query strings go in
  save_request's params, not the url.
- Skip {{dy_url}} only for one-off external calls: a full http(s):// url is
  sent verbatim (no base_url, no folder path).
- base_url resolves per request, most specific wins:
    1. the collection's own base_url (set_collection_base_url / create_collection)
    2. the environment's base_url variable
    3. built-in default http://localhost:8000
  Several services at once: one collection per service, each with its own
  base_url (:8001, :8002), so {{dy_url}} never collides. A collection base_url
  may contain {{vars}} so environments still switch stage per service. Never
  hardcode hosts in saved requests.

Cataloguing an API's endpoints (once per route, not per test):
1. list_collections -> find or create_collection.
2. get_collection -> folders (folder_id, path) + endpoints; check structure first.
3. create_folder (nest via parent_folder_id) — name folders after routes.
4. save_request with request.folder_id and a {{dy_url}}/... url.
5. run_saved_request (pass environment when vars/token needed).
Testing goes through flows, with the steps typed into the flow (below).
save_request while writing a test is how a collection fills with non-endpoints.

Flows — testing a whole feature, not one endpoint:
- A flow chains steps: login -> create -> read -> update -> delete. Steps pass
  values on with extract ({var:"user_id", from:"body", path:"data.id"}), used
  later as {{user_id}}. Run variables — a token a login script env.set()s
  included — live only for the run; the stored environment is untouched.
- Always give a flow a description: which case it covers and what it assumes,
  what a name has no room for. list_flows reports it, which is how the right
  flow is found again without opening every one.
- Changing a flow: get_flow answers in save_flow's input shape — edit that and
  pass it back, keeping each step's id. save_flow replaces the step list
  whole; a step sent without its id counts as new, stranding whatever still
  points at the old one. Other omitted fields keep their stored value.
- WHERE A STEP'S REQUEST LIVES. Default to mode:"inline", the request typed
  into the step. A step that exists to exercise a case is a test and belongs
  in its flow: an invalid payload, a restore call, a one-off probe, the same
  route with different data, anything named after what it proves. save_request
  is for the API's own endpoints, one entry per route, the call someone would
  send by hand later; if the collection already has the route, this is a case
  of it — inline it, or the catalogue stops being readable. An inline step may
  name a collection_id, which lends it only that collection's base_url and
  default auth — it has no folder, so {{dy_url}} is {{base_url}}.
- After building or changing a resource's endpoints, save_flow a CRUD flow and
  run_flow — that proves the routes work together, which running each request
  alone does not.
- A run stops at the first failure; steps marked always:true still run, so
  mark the delete step always:true and a failed run still cleans up.
- Checks. assert: source status|body|header|cookie|time (a request) or
  exit_code|stdout|stderr|time (a command), op eq|neq|exists|missing|contains|
  matches|lt|gt, a path into a JSON body or stdout; values may hold {{vars}}.
  script: JS with expect(cond, message) for what assert cannot say.
  when: [{var, op, value}] runs the step only while every condition holds,
  else skips it (not a failure), read against the environment and the run so
  far with an empty value counting as missing — so get-or-create is a lookup
  step extracting customer_id, then a create step with
  when:[{var:"customer_id", op:"missing"}] extracting the same name.
- A step can run a shell command instead (mode:"shell") — how a flow checks
  what no response shows: the row is really in the database, the file was
  written, the job ran. {{vars}} reach the command, so it can look up what an
  earlier step created:
    command:"docker exec db psql -tAc \\"select count(*) from users where id={{user_id}}\\""
  A non-zero exit fails the step unless the step asserts on exit_code, which
  is how a check that means to prove a failure says so.
- NEVER use mode:"shell" to call the API itself (curl/wget/httpie against the
  route under test): use the saved request or a mode:"inline" step, and
  save_request the route first if it is missing. curl bypasses the
  collection's auth, vars and dy_url and skips the cataloguing this MCP exists
  to keep up to date. Shell is only for what a response body can't prove: a
  database row, a file on disk, a log line, a job's exit state.
- Every command in a flow runs in the same shell: a cd or an export in one
  step is still in force in the next, and a step's own cwd cds there and stays
  there. Write a sequence as several steps with their own assertions, not one
  command joined with &&. shell_cwd is where that shell starts. Anything that
  ends it (exit, a timeout, a command printing over 1MB) leaves the next step
  to start a new one with none of that state, reported as fresh_shell;
  shell_session:false gives every command its own shell. Commands run on the
  machine hosting the backend, as that process.
- A command worth running more than once belongs in a collection, not typed
  into each flow: save_shell_test files it beside the endpoints it checks, a
  step points at it with collection_id + request_id like any saved request,
  and run_saved_request runs it alone (exit_code/stdout/stderr). Prefer an
  endpoint when one exists — a command ties the test to how the thing is
  deployed.
- Flows are filed in their own folder tree (list_flows, create_flow_folder,
  save_flow folder_id): organisation only, nothing to do with {{dy_url}} —
  name those folders after the feature under test, not after routes.

Where a {{var}} should live (most specific wins at run time):
- request vars (save_request request.vars, save_shell_test test.vars): an id
  only this call cares about, e.g. the {{user_id}} of a fetch-one, kept out of
  the environment where it would bury the few that are genuinely shared. Clear
  a value (or the whole object) to fall back to the environment.
- flow vars (save_flow vars): the flow's own inputs, e.g. {"project_id":"10"}
  for a flow that reuses an existing project. They start the run: over the
  environment and a saved request's own values, under anything a step captures.
- environment (set_env_var): shared across requests — base_url, token, a
  fixture id every call in a suite uses.
- A request's or flow's var is one value (the default environment's) or
  {"default":"11","remote90":"96"} where environments differ; an environment
  with no value of its own uses the default.

Post-response scripts (save_request request.script, save_shell_test test.script):
- JS run against the response; env.set(name, value) stores what it produced,
  e.g. on a login: env.set('token', res.json().access_token), so every later
  request resolves {{token}} through the collection's auth.
- Available: res.status, res.statusText, res.headers, res.cookies (parsed from
  Set-Cookie — how an HttpOnly refresh token is captured), res.body,
  res.json(); env.get(name) reads a variable back. A shell test's script also
  gets sh.exitCode / sh.stdout / sh.stderr (res.status is the exit code,
  res.body is stdout).
- A plain run writes env.set values into the active environment; in a flow
  they stay run-scoped.

Auth & environments:
- Collections may define a default auth (e.g. Bearer {{token}}) applied to
  requests lacking that header — never add Authorization headers by hand.
  A request's or inline step's auth says what it sends: {"type":"inherit"}
  (the default) takes the collection's, {"type":"none"} sends nothing,
  {"type":"bearer","token":"{{token}}","prefix":"Bearer"} or
  {"type":"apikey","header":"X-API-Key","value":"{{token}}"} give it its own.
- A login must set auth: {"type":"none"}. Otherwise it goes out carrying the
  token it exists to replace, and a backend that reads anything from that token
  (a timezone claim, a tenant) answers as the stale token's user — so the new
  token carries the old answer.
- On 401: run the login request first (its script saves the token via
  env.set), or store tokens with set_env_var.
- Tools take an environment by name or id.

Rules:
- Never save one request twice at once: save_request reads the stored request
  before writing it, so two parallel saves of the same request_id lose
  whichever landed first. Saves of different requests, and create_folder, are
  safe alongside each other — each is merged into the collection under a lock.
- Multipart/file bodies can't be created or edited here (body types: none,
  json, text) — a request already using one keeps it through save_request;
  its fields are edited in the app. A body is only sent when body_type is json
  or text, however many variants are stored.
- Deletes are permanent — there is no undo. A flow step pointing at a deleted
  request or collection stays in its flow and fails as missing when run; the
  reply's used_by_flows lists those steps for repointing with save_flow.
- Response bodies (and a command's stdout/stderr) come back cut at 4000 chars,
  marked body_truncated with body_length; pass max_body_chars to send_request
  / run_saved_request / run_flow when more is needed.
- Prefer get_collection / search_requests before get_request (token economy).`;
