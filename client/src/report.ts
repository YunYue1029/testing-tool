// What a run report may not carry out of the building. A report exists to be
// forwarded — that is the whole point of printing one — and the run it records
// was authenticated, so it holds bearer tokens, session cookies and whatever
// the login was given. Covering them is the default; the export offers to show
// them for a report that stays in the room.
import type { Vars } from './types.ts';

// Deliberately narrow. `auth_type` is not a secret and `id` is not a token:
// masking things that aren't only teaches a reader to look past the dots, and
// then the one that mattered goes past too.
const SECRET_KEY = /token|secret|password|passwd|pwd|api[-_]?key|authorization|cookie|session|jwt|credential/i;

export const MASK = '••••••';

export function looksSecret(key: string): boolean {
  return SECRET_KEY.test(key);
}

// A {name: value} map as report rows, secret-looking ones covered.
export function reportVars(vars: Vars | undefined, reveal: boolean): Array<[string, string]> {
  return Object.entries(vars || {}).map(
    ([k, v]) => [k, reveal || !looksSecret(k) ? String(v) : MASK] as [string, string],
  );
}

// A token handed over in a query string is as much a secret as one in a header,
// and the url is the line of a report most likely to be read over a shoulder.
export function maskUrl(url: string, reveal: boolean): string {
  const cut = url.indexOf('?');
  if (reveal || cut < 0) return url;
  const query = url.slice(cut + 1).split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    const key = pair.slice(0, eq);
    return looksSecret(key) ? `${key}=${MASK}` : pair;
  }).join('&');
  return `${url.slice(0, cut)}?${query}`;
}

// An assertion reads `body.access_token expected eq "eyJ…", got "eyJ…"`. That
// the check ran and passed is the evidence; the value is not, so the quoted
// values go behind dots when the assertion is about something secret.
export function maskDetail(detail: string, reveal: boolean): string {
  if (reveal) return detail;
  const subject = detail.split(' ')[0] || '';
  return looksSecret(subject) ? detail.replace(/"[^"]*"/g, `"${MASK}"`) : detail;
}

// Naming a value secret is not the same as knowing where it ends up. A token
// captured as `access_token` is masked in the table by its name, and then quoted
// back in full by an assertion whose subject was `status` — the check that read
// it had no idea what it was holding. So the values themselves are struck out
// wherever they appear, which is the only rule that holds for text nobody
// wrote with a report in mind.
export function secretValues(maps: Array<Vars | undefined>): string[] {
  const out = new Set<string>();
  for (const m of maps) {
    for (const [k, v] of Object.entries(m || {})) {
      const value = String(v ?? '').trim();
      // Short values are ids and status codes far more often than secrets, and
      // striking "0" out of a report would take half the page with it.
      if (looksSecret(k) && value.length >= 6) out.add(value);
    }
  }
  return [...out];
}

// Strike the given values out of any text the report prints. Longest first, so
// a value that contains another does not leave the shorter one's tail behind.
export function scrubber(values: string[]): (text: string) => string {
  if (!values.length) return (text) => text;
  const ordered = [...values].sort((a, b) => b.length - a.length);
  return (text) => ordered.reduce((t, v) => t.split(v).join(MASK), text);
}
