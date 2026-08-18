// The client's view of the domain.
//
// The stored shapes come from the server rather than a second copy kept here:
// this app reads and writes those exact records over /api, and a divergent
// Collection would only be a second thing to keep in step. `import type` is
// erased before the bundler sees it, so nothing crosses the package boundary
// at run time.
export type {
  ApiKeyAuth, Assertion, AssertOp, Auth, AuthType, BearerAuth, BodyType,
  Collection, CollectionAuth, Environment, Extraction, FileMeta, Flow, FlowReport,
  FlowShell, Folder, FormFileRow, FormRow, FormTextRow, HeaderPair,
  HttpRequest, HttpResponse, InlineBodyType, InlineRequest, Overrides,
  RequestBody, ResponseSnapshot, ResponseSource, Row, SavedRequest,
  SentSnapshot, ShellRequest, ShellResponse, ShellSource, Step, StepMode,
  StepReport, ValueSource, Vars,
} from '../../server/types.ts';

import type {
  Collection, Flow, Folder, HttpResponse, SavedRequest, ShellResponse,
} from '../../server/types.ts';

// ---- Client-only shapes ----

// The editable state behind an auth picker. Every type's fields are kept while
// you switch between them, so flipping to No Auth and back doesn't lose the
// token you just typed.
export interface AuthForm {
  type: string;
  token: string;
  prefix: string;
  header: string;
  value: string;
}

// What authentication a request will actually send, without revealing the
// secret behind it.
export interface AuthDescription {
  source: 'request' | 'own' | 'collection' | 'none' | 'off';
  headerName: string | null;
  expr: string;
  resolved: boolean;
  missing: string[];
}

// What came back from a run, as the panels show it. A shell test answers with
// a verdict instead of a response, which is why this is a union.
export type RunResponse = HttpResponse | ShellResponse;

// One row of the search results the sidebar renders.
export interface SearchHit {
  kind: 'request' | 'flow';
  key: string;
  score: number;
  label: string;
  route: string;
  detail: string;
  method: string;
  collection?: Collection;
  request?: SavedRequest;
  flow?: Flow;
}

// What searchWorkspace is given to search over.
export interface Workspace {
  collections?: Collection[];
  flows?: Flow[];
  flowFolders?: Folder[];
}

// A run of characters in a search result, marked or not.
export interface HighlightPart {
  text: string;
  hit: boolean;
}
