import { composeUrl, folderPath } from './util.ts';
import type {
  Collection, HighlightPart, SavedRequest, SearchHit, Workspace,
} from './types.ts';

// Finding a saved request by walking the tree means remembering which
// collection and which folder it went into. Searching means remembering any
// part of it — hence: match on everything the request shows of itself, and let
// where the hit landed decide the order.

// A query is split on whitespace and every term must match somewhere. Order
// doesn't matter, so "user post" finds "Create post for user" too.
function terms(query: string | null | undefined): string[] {
  return String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
}

// The path a request actually calls, without the host: the folder tree is the
// route tree here, so "{{dy_url}}/{{id}}/" in folder "users" searches as
// "/users/{{id}}/" — which is how you think of an endpoint when its name has
// slipped your mind.
function routeOf(col: Collection, r: SavedRequest): string {
  const composed = composeUrl(col.folders || [], r.folderId, 'url' in r ? r.url : '') || '';
  return composed.replace(/\{\{\s*base_url\s*\}\}/g, '');
}

// What a hit in each field is worth. A name is what you were reaching for; a
// url is what you settle for.
const WEIGHT: Record<string, number> = { name: 4, route: 3, where: 2, url: 1 };

// The four strings an item is matched against.
type Fields = { name: string; route: string; where: string; url: string };
const METHOD_WEIGHT = 2;

// The best a single term scores against one item, or 0 if it appears nowhere —
// which disqualifies the item entirely.
function scoreTerm(term: string, fields: Fields, method: string): number {
  let best = method === term ? METHOD_WEIGHT : 0;
  for (const key of Object.keys(fields)) {
    const at = fields[key as keyof Fields].indexOf(term);
    if (at < 0) continue;
    // Matching from the start of a field beats matching in the middle of it.
    const score = WEIGHT[key]! + (at === 0 ? 2 : 0);
    if (score > best) best = score;
  }
  return best;
}

function scoreItem(ts: string[], fields: Fields, method: string): number {
  let total = 0;
  for (const t of ts) {
    const s = scoreTerm(t, fields, method);
    if (!s) return 0; // every term has to land somewhere
    total += s;
  }
  return total;
}

// The second line of a result row. Normally where the item lives, but when the
// terms are nowhere in the two visible strings the hit came from the route, and
// a row with nothing marked on it reads as a mistake — so show the route.
function detailFor(ts: string[], label: string, where: string, route: string): string {
  const shown = `${label} ${where}`.toLowerCase();
  return ts.every((t) => shown.includes(t)) ? (where || route) : (route || where);
}

// Rank the requests and flows matching `query`, best first. Each result carries
// what the sidebar needs to render and open it without looking anything up
// again.
export function searchWorkspace(
  { collections, flows, flowFolders }: Workspace,
  query: string,
  limit = 60,
): SearchHit[] {
  const ts = terms(query);
  if (!ts.length) return [];

  const out: SearchHit[] = [];

  for (const col of collections || []) {
    for (const r of col.requests || []) {
      const where = [col.name, folderPath(col.folders || [], r.folderId)]
        .filter(Boolean).join(' / ');
      // A shell test has no route — what it runs is the command, so that is
      // what stands in for both the route and the url here: "psql" finds the
      // check that counts the rows, the same way "/users" finds the endpoint.
      const shell = r.kind === 'shell';
      const route = r.kind === 'shell' ? (r.command || '') : routeOf(col, r);
      const what = r.kind === 'shell' ? r.command : r.url;
      const label = r.name || what || 'Untitled';
      const score = scoreItem(ts, {
        name: label.toLowerCase(),
        route: route.toLowerCase(),
        where: where.toLowerCase(),
        url: (what || '').toLowerCase(),
      }, r.kind === 'shell' ? 'sh' : (r.method || '').toLowerCase());
      if (score) {
        out.push({
          kind: 'request', key: r.id, score, label, route,
          detail: detailFor(ts, label, where, route),
          method: r.kind === 'shell' ? 'SH' : r.method, collection: col, request: r,
        });
      }
    }
  }

  for (const f of flows || []) {
    const label = f.name || 'Untitled';
    const where = folderPath(flowFolders || [], f.folderId);
    const score = scoreItem(ts, {
      name: label.toLowerCase(),
      where: where.toLowerCase(),
      route: '',
      url: '',
    }, 'flow');
    if (score) {
      const steps = `${(f.steps || []).length} steps`;
      out.push({
        kind: 'flow', key: `flow:${f.id}`, score, label, route: steps,
        detail: where ? `${where} · ${steps}` : steps,
        method: 'FLOW', flow: f,
      });
    }
  }

  return out
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, limit);
}

// Split `text` into runs of matched / unmatched characters, so the parts that
// answered the query can be marked in the result row.
export function highlightParts(
  text: string | null | undefined, query: string,
): HighlightPart[] {
  const s = String(text || '');
  const ts = terms(query);
  if (!ts.length || !s) return [{ text: s, hit: false }];

  const lower = s.toLowerCase();
  const hit = new Array(s.length).fill(false);
  for (const t of ts) {
    let at = lower.indexOf(t);
    while (at >= 0) {
      for (let i = at; i < at + t.length; i += 1) hit[i] = true;
      at = lower.indexOf(t, at + t.length);
    }
  }

  const parts: HighlightPart[] = [];
  for (let i = 0; i < s.length; i += 1) {
    const last = parts[parts.length - 1];
    if (last && last.hit === hit[i]) last.text += s[i];
    else parts.push({ text: s[i]!, hit: hit[i]! });
  }
  return parts;
}
