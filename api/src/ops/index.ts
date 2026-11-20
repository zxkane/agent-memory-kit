import { ApiError } from '../errors.ts';
import type { Domain, Note } from '../snapshot.ts';
import type { Store } from '../store.ts';
import { tagIndexText } from '../tags.ts';
import { cutToBytes } from '../text.ts';
import { onlyParams, parseScope, scopeKeyPrefix, scopeName } from '../validate.ts';

const MAX_INDEX_BYTES = 25_000;

// The labels of the notes of one scope, by file name. Without the snapshots the index goes out untagged.
async function domainsOf(snapshots: { load(): Promise<Note[]> }, scope: string): Promise<Map<string, Domain>> {
  const domains = new Map<string, Domain>();
  try {
    for (const note of await snapshots.load()) {
      const at = note.path.lastIndexOf('/');
      if (note.domain && note.path.slice(0, at) === scope) domains.set(note.path.slice(at + 1), note.domain);
    }
  } catch {
    domains.clear();
  }
  return domains;
}

export async function memoryIndex(
  deps: { store: Store; snapshots: { load(): Promise<Note[]> } },
  query: Record<string, string | undefined>,
): Promise<{ scope: string; index: string; truncated: boolean }> {
  onlyParams(query, ['scope']);
  const scope = parseScope(query.scope);
  const res = await deps.store.get(`${scopeKeyPrefix(scope)}MEMORY.md`);
  if (res.status === 'missing') throw new ApiError(404, 'not_found', 'this scope has no index');
  if (res.status !== 'ok') throw new ApiError(500, 'internal', 'the index could not be read');
  const name = scopeName(scope);
  const tagged = tagIndexText(res.body, await domainsOf(deps.snapshots, name));
  const cut = cutToBytes(tagged, MAX_INDEX_BYTES);
  return { scope: name, index: cut.text, truncated: cut.truncated };
}
