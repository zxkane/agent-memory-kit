// Write order: the agents search snapshot is updated first, in one conditional update that also
// enforces the caps, so both caps are exact under concurrent writes. Then the note file is put
// and the scope's MEMORY.md is updated.
//
// Consequence: if the note put or the index update fails, the snapshot already lists the note, so a
// search may return a path that reads as 404 until the same request is retried. The retry repairs
// it (every step is idempotent), but it reports created: false, because the snapshot already
// listed the note.
import { scanText } from '../../../workstation/lib/secret-scan.mjs';
import { ApiError } from '../errors.ts';
import { composeNote, upsertIndexLine } from '../note-file.ts';
import { listNotes, upsertNote } from '../snapshot.ts';
import type { Store } from '../store.ts';
import { update } from '../store.ts';
import { parseWrite } from '../validate.ts';

const MAX_SCOPE_NOTES = 200;
const MAX_SNAPSHOT_BYTES = 4_000_000;
const SNAPSHOT_KEY = 'index/agents.json';

function refuseCredentials(text: string): void {
  const first = (scanText(text) as { id: string }[])[0];
  if (first) {
    throw new ApiError(400, 'secret_detected', `the note looks like it contains a credential (${first.id})`);
  }
}

export async function memoryWrite(deps: { store: Store }, body: unknown): Promise<{ path: string; created: boolean }> {
  const req = parseWrite(body);
  refuseCredentials(req.name);
  refuseCredentials(req.description);
  refuseCredentials(req.content);

  const { store } = deps;
  // Every key is built from the validated agent and name: both are plain slugs.
  const path = `agents/${req.agent}/${req.name}.md`;
  const scopePrefix = `agents/${req.agent}/`;
  let created = false;

  await update(store, SNAPSHOT_KEY, (current) => {
    const notes = listNotes(current);
    created = !notes.some((n) => n.path === path);
    if (created && notes.filter((n) => n.path.startsWith(scopePrefix)).length >= MAX_SCOPE_NOTES) {
      throw new ApiError(400, 'scope_full', 'this scope already holds the maximum number of notes');
    }
    const next = upsertNote(current, {
      path,
      name: req.name,
      description: req.description,
      type: req.type,
      body: req.content,
    });
    if (Buffer.byteLength(next, 'utf8') > MAX_SNAPSHOT_BYTES) {
      throw new ApiError(400, 'store_full', 'the agent memory store is full');
    }
    return next;
  });

  await store.put(path, composeNote(req), null);
  await update(store, `${scopePrefix}MEMORY.md`, (current) => upsertIndexLine(current, req.name, req.description));
  return { path, created };
}
