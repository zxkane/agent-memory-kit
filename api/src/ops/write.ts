import { scanText } from '../../../workstation/lib/secret-scan.mjs';
import { ApiError } from '../errors.ts';
import { composeNote, countIndexNotes, upsertIndexLine } from '../note-file.ts';
import { upsertNote } from '../snapshot.ts';
import type { Store } from '../store.ts';
import { update } from '../store.ts';
import { parseWrite } from '../validate.ts';

const MAX_SCOPE_NOTES = 200;
const SNAPSHOT_KEY = 'index/agents.json';

function refuseCredentials(text: string): void {
  const findings = scanText(text) as { id: string }[];
  const first = findings[0];
  if (first) {
    throw new ApiError(400, 'secret_detected', `the note looks like it contains a credential (${first.id})`);
  }
}

export async function memoryWrite(deps: { store: Store }, body: unknown): Promise<{ path: string; created: boolean }> {
  const req = parseWrite(body);
  refuseCredentials(req.description);
  refuseCredentials(req.content);

  const { store } = deps;
  // Every key is built from the validated agent and name: both are plain slugs.
  const path = `agents/${req.agent}/${req.name}.md`;
  const indexKey = `agents/${req.agent}/MEMORY.md`;

  const existing = await store.get(path);
  if (existing.status === 'not-modified') throw new ApiError(500, 'internal', 'the note could not be read');
  const created = existing.status === 'missing';
  if (created) {
    const index = await store.get(indexKey);
    const text = index.status === 'ok' ? index.body : null;
    if (countIndexNotes(text) >= MAX_SCOPE_NOTES) {
      throw new ApiError(400, 'scope_full', 'this scope already holds the maximum number of notes');
    }
  }

  await store.put(path, composeNote(req), null);
  await update(store, indexKey, (current) => upsertIndexLine(current, req.name, req.description));
  await update(store, SNAPSHOT_KEY, (current) =>
    upsertNote(current, {
      path,
      name: req.name,
      description: req.description,
      type: req.type,
      body: req.content,
    }),
  );
  return { path, created };
}
