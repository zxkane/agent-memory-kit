import type { Note } from '../snapshot.ts';
import { onlyParams, parseLimit, parseQuery, parseScope, scopeName } from '../validate.ts';

export type SearchResult = {
  path: string;
  scope: string;
  name: string;
  description: string;
  snippet: string;
  score: number;
};

const NAME_WEIGHT = 8;
const DESCRIPTION_WEIGHT = 4;
const BODY_CAP = 5;
const SNIPPET_SIDE = 120;

type Lowered = { name: string; description: string; body: string };

// Snapshots are cached between requests, so cache the lower-cased text per note object.
const loweredCache = new WeakMap<Note, Lowered>();

function lowered(note: Note): Lowered {
  let found = loweredCache.get(note);
  if (!found) {
    found = {
      name: note.name.toLowerCase(),
      description: note.description.toLowerCase(),
      body: note.body.toLowerCase(),
    };
    loweredCache.set(note, found);
  }
  return found;
}

function countUpTo(haystack: string, needle: string, cap: number): number {
  let count = 0;
  let from = 0;
  while (count < cap) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count++;
    from = at + needle.length;
  }
  return count;
}

function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function makeSnippet(note: Note, low: Lowered, terms: string[]): string {
  for (const term of terms) {
    const at = low.body.indexOf(term);
    if (at < 0) continue;
    const body = note.body;
    let start = Math.max(0, at - SNIPPET_SIDE);
    let end = Math.min(body.length, at + Math.max(SNIPPET_SIDE, term.length));
    if (start > 0 && isLow(body.charCodeAt(start))) start++;
    if (end < body.length && isHigh(body.charCodeAt(end - 1))) end--;
    const window = body.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '…' : ''}${window}${end < body.length ? '…' : ''}`;
  }
  return note.description;
}

export async function memorySearch(
  deps: { snapshots: { load(): Promise<Note[]> } },
  query: Record<string, string | undefined>,
): Promise<{ results: SearchResult[]; total: number }> {
  onlyParams(query, ['q', 'scope', 'limit']);
  const terms = parseQuery(query.q);
  const scope = query.scope === undefined ? undefined : scopeName(parseScope(query.scope));
  const limit = parseLimit(query.limit);

  const candidates: Array<{ note: Note; scope: string; low: Lowered; distinct: number; score: number }> = [];
  for (const note of await deps.snapshots.load()) {
    const noteScope = note.path.slice(0, note.path.lastIndexOf('/'));
    if (scope !== undefined && noteScope !== scope) continue;
    const low = lowered(note);
    let distinct = 0;
    let score = 0;
    for (const term of terms) {
      let termScore = 0;
      if (low.name.includes(term)) termScore += NAME_WEIGHT;
      if (low.description.includes(term)) termScore += DESCRIPTION_WEIGHT;
      const inBody = countUpTo(low.body, term, BODY_CAP);
      if (termScore > 0 || inBody > 0) distinct++;
      score += termScore + inBody;
    }
    if (distinct > 0) candidates.push({ note, scope: noteScope, low, distinct, score });
  }

  candidates.sort(
    (a, b) =>
      b.distinct - a.distinct ||
      b.score - a.score ||
      (a.note.path < b.note.path ? -1 : a.note.path > b.note.path ? 1 : 0),
  );

  return {
    results: candidates.slice(0, limit).map((c) => ({
      path: c.note.path,
      scope: c.scope,
      name: c.note.name,
      description: c.note.description,
      snippet: makeSnippet(c.note, c.low, terms),
      score: c.score,
    })),
    total: candidates.length,
  };
}
