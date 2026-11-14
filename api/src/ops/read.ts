import { ApiError } from '../errors.ts';
import type { Store } from '../store.ts';
import { cutToBytes } from '../text.ts';
import { onlyParams, parseNotePath, scopeKeyPrefix, scopeName } from '../validate.ts';

const MAX_NOTE_BYTES = 100_000;

export async function memoryRead(
  deps: { store: Store },
  query: Record<string, string | undefined>,
): Promise<{ path: string; content: string; truncated: boolean }> {
  onlyParams(query, ['path']);
  const { scope, file } = parseNotePath(query.path);
  const res = await deps.store.get(`${scopeKeyPrefix(scope)}${file}`);
  if (res.status === 'missing') throw new ApiError(404, 'not_found', 'this note does not exist');
  if (res.status !== 'ok') throw new ApiError(500, 'internal', 'the note could not be read');
  const cut = cutToBytes(res.body, MAX_NOTE_BYTES);
  return { path: `${scopeName(scope)}/${file}`, content: cut.text, truncated: cut.truncated };
}
