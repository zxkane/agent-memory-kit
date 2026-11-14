import { ApiError } from '../errors.ts';
import type { Store } from '../store.ts';
import { cutToBytes } from '../text.ts';
import { onlyParams, parseScope, scopeKeyPrefix, scopeName } from '../validate.ts';

const MAX_INDEX_BYTES = 25_000;

export async function memoryIndex(
  deps: { store: Store },
  query: Record<string, string | undefined>,
): Promise<{ scope: string; index: string; truncated: boolean }> {
  onlyParams(query, ['scope']);
  const scope = parseScope(query.scope);
  const res = await deps.store.get(`${scopeKeyPrefix(scope)}MEMORY.md`);
  if (res.status === 'missing') throw new ApiError(404, 'not_found', 'this scope has no index');
  if (res.status !== 'ok') throw new ApiError(500, 'internal', 'the index could not be read');
  const cut = cutToBytes(res.body, MAX_INDEX_BYTES);
  return { scope: scopeName(scope), index: cut.text, truncated: cut.truncated };
}
