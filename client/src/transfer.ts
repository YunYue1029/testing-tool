// Moving a workspace, or part of one, between machines: our own export file
// in either direction, and a Postman collection or environment coming in.
// The dialog that picks what travels is TransferModal; the state behind it and
// the calls that do the moving are here.
import { api } from './api.ts';

// The export/import dialog's state: which direction, what each section holds,
// and — importing — the file waiting to be written.
export interface TransferState {
  mode: 'export' | 'import';
  counts: Record<string, number>;
  exportedAt?: string;
  data?: Record<string, unknown>;
}

// What /api/import/workspace reports back. Every section is optional: one
// left out of the transfer has no key here at all, rather than a zero.
interface ImportResult {
  applied?: string[];
  collections?: { added: number; updated: number };
  flows?: { added: number; updated: number };
  environments?: { added: number; updated: number };
  flowFolders?: number;
  baseUrls?: number;
  fileFields?: number;
  missingRequests?: { steps: number; flows: string[] };
}

// What /api/import/postman reports back: a collection import, or an
// environment one, which carries a variable count instead of requests.
interface PostmanImportResult {
  type: 'collection' | 'environment';
  collections?: string[];
  requests?: number;
  folders?: number;
  baseUrl?: string;
  name?: string;
  variables?: number;
}

// The import button takes either format; which one it is, is in the file.
export function isWorkspaceFile(data: Record<string, unknown>): boolean {
  return !!data && (data.format === 'testing-tool/workspace' || data.format === 'api-test/workspace');
}

// One of our own export files, sized up for the picker. A section the file
// doesn't carry is left out entirely — the counts are what is in the file,
// not what is in this workspace. Null when it carries nothing at all.
export function describeImport(data: Record<string, unknown>): TransferState | null {
  const counts: Record<string, number> = {};
  if (Array.isArray(data.collections)) counts.tests = data.collections.length;
  if (Array.isArray(data.flows)) counts.flows = data.flows.length;
  if (Array.isArray(data.environments)) counts.environments = data.environments.length;
  if (!Object.keys(counts).length) return null;
  return { mode: 'import', counts, exportedAt: data.exportedAt as string | undefined, data };
}

// Part of this workspace, or all of it, as one file for a second machine to
// import, dropped straight into the browser's downloads.
export async function downloadExport(include: string[]): Promise<void> {
  const data = await api.exportAll(include);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  );
  const a = document.createElement('a');
  a.href = url;
  // The scope in the name: three files in a downloads folder are otherwise
  // told apart only by opening them.
  const scope = include.length === 3 ? '' : `-${include.join('-')}`;
  a.download = `testing-tool${scope}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Restore an export file onto this machine. Same ids as the machine it came
// from, so a second import updates rather than duplicates. Answers with the
// summary to show.
export async function importWorkspace(
  data: Record<string, unknown> | undefined, include: string[],
): Promise<string> {
  const r = await api.importWorkspace(data, include) as ImportResult;
  const line = (name: string, c: { added: number; updated: number }) =>
    `${name}: ${c.added} added, ${c.updated} updated`;
  const lines: string[] = [];
  if (r.collections) lines.push(line('Tests', r.collections));
  if (r.flows) lines.push(line('Flows', r.flows));
  if (r.environments) lines.push(line('Environments', r.environments));
  if (r.baseUrls !== undefined) lines.push(`Base URLs: ${r.baseUrls} added`);
  if (!lines.length) lines.push('Nothing imported.');
  if (r.fileFields) {
    lines.push(
      '',
      `${r.fileFields} form-data file field(s) point at uploads that stayed on the other `
      + 'machine — pick those files again here.'
    );
  }
  // Flows whose steps name a saved request this machine hasn't got: they
  // will fail on that step, so say it now rather than at the first run.
  if (r.missingRequests) {
    lines.push(
      '',
      `${r.missingRequests.steps} step(s) in ${r.missingRequests.flows.join(', ')} `
      + 'run a saved request that is not on this machine — import the Tests too.'
    );
  }
  return lines.join('\n');
}

// A Postman v2.x collection or environment export. Answers with the summary
// to show.
export async function importPostman(data: Record<string, unknown>): Promise<string> {
  const result = await api.importPostman(data) as unknown as PostmanImportResult;
  if (result.type === 'environment') {
    return `Imported environment "${result.name}" (${result.variables} variables).`;
  }
  const lines = [
    `Imported ${result.requests} requests in ${result.folders} folders `
    + `into ${(result.collections || []).join(', ')}.`,
  ];
  // An export that names its host with a {{variable}} carries no value
  // for it, so say what has to be defined before anything will resolve.
  if (result.baseUrl) {
    lines.push('', `Base URL: ${result.baseUrl}`);
    const token = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(result.baseUrl);
    if (token) lines.push(`Set "${token[1]}" in an environment to point the collection somewhere.`);
  }
  return lines.join('\n');
}
