// The shapes that live on disk and travel through the API.
//
// These are written from what store.ts actually normalises to and what
// runner.ts / flow.ts actually read — the JSON files under data/ are the real
// schema, so where a field is optional here it is because a stored record can
// genuinely lack it, not because it was easier to write.
//
// Two flavours of most records:
//   Foo       — the normalised shape, what store.ts writes and hands back
//   FooInput  — what a caller may supply, all optional, because it arrives as
//               an HTTP body and is normalised on the way in
// The runtime checks in store.ts stay exactly as they were: FooInput says what
// a well-behaved caller sends, not what the server is willing to trust.

// ---- Key/value rows (headers, query params, per-request variables) ----
export interface Row {
  key: string;
  value: string;
  // Absent counts as enabled; only an explicit false switches a row off.
  enabled?: boolean;
}

// ---- Auth ----
export type AuthType = 'inherit' | 'none' | 'bearer' | 'apikey';

export interface BearerAuth {
  type: 'bearer';
  token: string;
  // Absent means "Bearer"; an empty string means send the token bare.
  prefix?: string;
}
export interface ApiKeyAuth {
  type: 'apikey';
  header: string;
  value: string;
}
export interface InheritAuth { type: 'inherit' }
export interface NoneAuth { type: 'none' }

export type Auth = BearerAuth | ApiKeyAuth | InheritAuth | NoneAuth;

// A collection's default auth is either structured, or the legacy raw header
// string, or '' for off.
export type CollectionAuth = Auth | string;

// What authHeader() resolves either of those down to.
export interface HeaderPair {
  name: string;
  value: string;
}

// ---- Folders ----
// One flat list per collection, threaded into a tree by parentId. Flow folders
// use the identical shape, which is why folderChain/folderPath work on both.
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
}

// ---- Requests ----
export type BodyType = 'none' | 'json' | 'text' | 'form';

// A named body variant. A request keeps several and sends activeBodyId's.
export interface RequestBody {
  id: string;
  name: string;
  content: string;
}

export interface FormTextRow {
  key: string;
  type: 'text';
  value: string;
  enabled?: boolean;
}
export interface FormFileRow {
  key: string;
  type: 'file';
  value?: string;
  enabled?: boolean;
  // The upload this row sends; absent until a file has been picked.
  fileId?: string;
  // A Postman import records the exporting machine's path, which is a hint
  // about which file to attach and nothing more.
  fileHint?: string;
  // Kept beside the id so the row can name the file without fetching it back.
  fileName?: string;
  fileSize?: number;
}
export type FormRow = FormTextRow | FormFileRow;

interface RequestCommon {
  id: string;
  name: string;
  // Optional because shapeCollection never normalised requests — it stores
  // whatever it was handed, and a request filed at the root may simply omit it.
  folderId?: string | null;
  // Values only this request needs — the {{user_id}} of a fetch-one — so an id
  // one call cares about need not be declared in an environment.
  vars?: Row[];
  // Post-response script. Runs in runner.ts under vm.
  script?: string;
}

// Everything runRequest actually needs to send something. A saved request is
// one of these; so is the request typed straight into a flow step, which is
// never stored on its own and so has no id and no name.
export interface RunnableHttpRequest {
  // Absent on every request saved before shell tests existed, which is why it
  // is optional rather than a required 'http'.
  kind?: 'http';
  method: string;
  url: string;
  folderId?: string | null;
  params?: Row[];
  headers?: Row[];
  bodyType?: BodyType;
  bodies?: RequestBody[];
  activeBodyId?: string;
  form?: FormRow[];
  auth?: Auth;
  // The older spelling of auth.type === 'none', still on requests saved before
  // a request could carry auth of its own.
  noAuth?: boolean;
  vars?: Row[];
  script?: string;
}

export interface HttpRequest extends RunnableHttpRequest, RequestCommon {}

// What a flow step hands the runner: a saved request of either kind, or an
// inline one that only exists inside the step.
export type RunnableRequest = RunnableHttpRequest | ShellRequest;

// A test that proves its point at a shell rather than over HTTP.
export interface ShellRequest extends RequestCommon {
  kind: 'shell';
  command: string;
  cwd?: string;
  timeout?: number;
}

export type SavedRequest = HttpRequest | ShellRequest;

// ---- Collections ----
export interface Collection {
  id: string;
  name: string;
  auth: CollectionAuth;
  baseUrl: string;
  folders: Folder[];
  requests: SavedRequest[];
  updatedAt: string;
}

export interface CollectionInput {
  id?: string;
  name?: string;
  auth?: CollectionAuth | null;
  baseUrl?: string;
  folders?: Folder[];
  requests?: SavedRequest[];
  updatedAt?: string;
}

// ---- Environments ----
export interface Environment {
  id: string;
  name: string;
  variables: Record<string, string>;
  // Keys that keep their value but are excluded from substitution.
  disabled: string[];
  updatedAt: string;
}

export interface EnvironmentInput {
  id?: string;
  name?: string;
  variables?: Record<string, string>;
  disabled?: string[];
  updatedAt?: string;
}

// A resolved {{var}} -> value map.
export type Vars = Record<string, string>;

// ---- Flows ----
export type StepMode = 'saved' | 'inline' | 'shell';
export type InlineBodyType = 'none' | 'json' | 'text';

// A request typed straight into a step. Deliberately smaller than a saved
// request: one body, no form-data, no script of its own.
export interface InlineRequest {
  method: string;
  url: string;
  headers: Row[];
  params: Row[];
  bodyType: InlineBodyType;
  body: string;
  auth: Auth;
}

// Where an extraction or assertion reads from, for a step that sent a request.
export type ResponseSource = 'status' | 'header' | 'cookie' | 'time' | 'body';
// …and for a step that ran a command.
export type ShellSource = 'exit_code' | 'stdout' | 'stderr' | 'time';
export type ValueSource = ResponseSource | ShellSource;

export interface Extraction {
  // The run variable to bind the value to.
  var: string;
  from?: ValueSource;
  path?: string;
}

export type AssertOp =
  | 'eq' | 'neq' | 'contains' | 'matches' | 'lt' | 'gt' | 'exists' | 'missing';

export interface Assertion {
  source?: ValueSource;
  path?: string;
  op?: AssertOp;
  // Usually a string, because it is typed into a form — but a JSON body can
  // carry a number, and the MCP schema accepts a boolean too, which is why
  // compare() has a branch for the non-string case rather than substituting
  // blindly.
  value?: string | number | boolean;
}

// Per-step changes to what the saved request sends.
export interface Overrides {
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface Step {
  id: string;
  name: string;
  mode: StepMode;
  // Optional in inline mode, where it contributes only base_url and auth.
  collectionId: string | null;
  requestId: string | null;
  request?: InlineRequest;
  command: string;
  cwd: string;
  timeout?: number;
  enabled: boolean;
  // Teardown: runs even after an earlier step failed.
  always: boolean;
  overrides?: Overrides;
  extract: Extraction[];
  assert: Assertion[];
  script: string;
}

export interface FlowShell {
  // One shell for the whole run, so a cd or an export reaches later steps.
  session: boolean;
  cwd: string;
}

export interface Flow {
  id: string;
  name: string;
  description: string;
  folderId: string | null;
  environmentId: string | null;
  shell: FlowShell;
  steps: Step[];
  updatedAt: string;
}

export interface StepInput extends Partial<Omit<Step, 'mode' | 'request'>> {
  // Unnormalised: a caller may send anything here, and store.ts checks it
  // against STEP_MODES before it is stored.
  mode?: string;
  // Likewise partial — inlineRequest() fills in every field it needs.
  request?: Partial<InlineRequest>;
}

export interface FlowInput {
  id?: string;
  name?: string;
  description?: string;
  folderId?: string | null;
  environmentId?: string | null;
  shell?: Partial<FlowShell>;
  steps?: StepInput[];
  updatedAt?: string;
  // Flows filed by a plain label, before folders existed. migrateFlowGroups
  // turns each distinct one into a top-level folder and save() drops it.
  group?: string;
}

// ---- Uploaded files ----
export interface FileMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  uploadedAt: string;
}

export interface StoredFile {
  meta: FileMeta;
  buffer: Buffer;
}

// ---- What actually goes out, and what comes back ----
export interface SentRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  form?: SentFormRow[];
}

export type SentFormRow =
  | { key: string; type: 'text'; value: string }
  | { key: string; type: 'file'; fileId?: string };

export interface HttpResponse {
  // Never set on the wire — it is the absence of ShellResponse's 'shell' that
  // identifies an HTTP response. Declared so the two form a discriminated
  // union that narrows on `kind` from either side.
  kind?: 'http';
  status: number;
  statusText: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  time: number;
  size: number;
}

// A shell test's result in response clothing, so one report shape covers both.
export interface ShellResponse {
  kind: 'shell';
  exitCode: number;
  stdout: string;
  stderr: string;
  time: number;
  size: number;
}

// What a command actually did. Distinct from ShellResponse: this is what
// shell.ts resolves with, before anything has been shaped for a report.
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timeMs: number;
  // The session shell had died and a new one was started, so anything earlier
  // steps had cd'd into or exported is gone.
  freshShell?: boolean;
}

// What runScript's `res` binding is built from — an HTTP response, or a
// command's result wearing the same shape.
export interface ScriptResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  cookies?: Record<string, string>;
  body: string;
}

export interface ScriptResult {
  ran: boolean;
  error?: string;
}

// What a step's script reported back, as it appears in a run report.
export interface ScriptReport {
  saved?: Vars;
  error?: string;
}

// Split by what actually ran, so a caller that asked for a shell test does not
// have to narrow a union it already knows the answer to.
export interface HttpRunResult {
  request: SentRequest;
  response: HttpResponse;
  script?: ScriptReport;
  vars: Vars;
}

export interface ShellRunResult {
  request: SentShellCommand;
  response: ShellResponse;
  script?: ScriptReport;
  vars: Vars;
}

export type RunResult = HttpRunResult | ShellRunResult;

// What a shell test ran, reported instead of a SentRequest.
export interface SentShellCommand {
  command: string;
  // The template it came from, when a {{var}} made the two differ.
  commandRaw?: string;
  cwd?: string;
}

// ---- Run reports ----
export interface AssertionResult {
  ok: boolean;
  detail: string;
}

export interface ResponseSnapshot {
  headers: Record<string, string>;
  cookies: Record<string, string>;
  size: number;
  bodyEncoding: 'utf8' | 'base64';
  body: string;
  truncated: boolean;
}

export interface SentSnapshot {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  bodyTruncated?: boolean;
  form?: Array<{ key: string; file?: true; value?: string }>;
}

export interface StepReport {
  id: string;
  name: string;
  always: boolean;
  ok: boolean;
  skipped?: string;
  mode?: 'shell';
  error?: string;
  hint?: string;
  request?: SentSnapshot;
  status?: number;
  statusText?: string;
  timeMs?: number;
  extracted?: Vars;
  assertions?: AssertionResult[];
  script?: ScriptReport;
  response?: ResponseSnapshot;
  // Shell steps
  command?: string;
  commandRaw?: string;
  cwd?: string;
  exitCode?: number;
  freshShell?: boolean;
  shell?: {
    stdout: string;
    stderr: string;
    truncated: boolean;
  };
}

export interface FlowReport {
  flowId: string;
  name: string;
  ok: boolean;
  startedAt: string;
  durationMs: number;
  steps: StepReport[];
  vars: Vars;
}
