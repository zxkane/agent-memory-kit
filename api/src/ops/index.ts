import { ApiError } from '../errors.ts';
import type { Domain, Note } from '../snapshot.ts';
import type { Store } from '../store.ts';
import { tagIndexText } from '../tags.ts';
import { cutToBytes } from '../text.ts';
import { onlyParams, parseScope, scopeKeyPrefix, scopeName } from '../validate.ts';

const MAX_INDEX_BYTES = 25_000;

// The labels of the notes of one scope, by file name. Without the snapshots the index goes out untagged.
async function domainsOf(
  snapshots: { load(): Promise<Note[]> },
  scope: string,
  log?: (line: object) => void,
): Promise<Map<string, Domain>> {
  const domains = new Map<string, Domain>();
  try {
    for (const note of await snapshots.load()) {
      const at = note.path.lastIndexOf('/');
      if (note.domain && note.path.slice(0, at) === scope) domains.set(note.path.slice(at + 1), note.domain);
    }
  } catch (err) {
    domains.clear();
    // One line says the index went out untagged; the name of the error only, never its message.
    const error = err instanceof ApiError ? err.code : err instanceof Error ? err.name : 'unknown';
    log?.({ op: 'memory_index', untagged: true, error });
  }
  return domains;
}

export async function memoryIndex(
  deps: { store: Store; snapshots: { load(): Promise<Note[]> }; log?: (line: object) => void },
  query: Record<string, string | undefined>,
): Promise<{ scope: string; index: string; truncated: boolean }> {
  onlyParams(query, ['scope']);
  const scope = parseScope(query.scope);
  const res = await deps.store.get(`${scopeKeyPrefix(scope)}MEMORY.md`);
  if (res.status === 'missing') throw new ApiError(404, 'not_found', 'this scope has no index');
  if (res.status !== 'ok') throw new ApiError(500, 'internal', 'the index could not be read');
  const name = scopeName(scope);
  const tagged = tagIndexText(res.body, await domainsOf(deps.snapshots, name, deps.log));
  const cut = cutToBytes(tagged, MAX_INDEX_BYTES);
  return { scope: name, index: cut.text, truncated: cut.truncated };
}
