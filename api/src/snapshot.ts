import { ApiError } from './errors.ts';
import type { Store } from './store.ts';
import { parseNotePath } from './validate.ts';

export type Note = { path: string; name: string; description: string; type: string; body: string };

const SNAPSHOT_KEYS = ['index/mem.json', 'index/agents.json'];

function unreadable(): ApiError {
  return new ApiError(500, 'internal', 'the search snapshot is unreadable');
}

function isNote(value: unknown): value is Note {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  if (
    typeof o.path !== 'string' ||
    typeof o.name !== 'string' ||
    typeof o.description !== 'string' ||
    typeof o.type !== 'string' ||
    typeof o.body !== 'string'
  ) {
    return false;
  }
  try {
    parseNotePath(o.path);
  } catch {
    return false;
  }
  return true;
}

function parseSnapshot(text: string): Note[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw unreadable();
  }
  const notes = (doc as { notes?: unknown } | null)?.notes;
  if (!Array.isArray(notes)) throw unreadable();
  return notes.filter(isNote).map((n) => ({
    path: n.path,
    name: n.name,
    description: n.description,
    type: n.type,
    body: n.body,
  }));
}

export function createSnapshots(store: Store): { load(): Promise<Note[]> } {
  const cache = new Map<string, { etag: string; notes: Note[] }>();

  async function loadOne(key: string): Promise<Note[]> {
    const cached = cache.get(key);
    const res = await store.get(key, cached?.etag);
    if (res.status === 'missing') {
      cache.delete(key);
      return [];
    }
    if (res.status === 'not-modified') {
      if (cached) return cached.notes;
      // Not-modified without a cached copy cannot be served; fetch unconditionally.
      const fresh = await store.get(key);
      if (fresh.status !== 'ok') return [];
      const notes = parseSnapshot(fresh.body);
      cache.set(key, { etag: fresh.etag, notes });
      return notes;
    }
    const notes = parseSnapshot(res.body);
    cache.set(key, { etag: res.etag, notes });
    return notes;
  }

  return {
    async load() {
      const lists = await Promise.all(SNAPSHOT_KEYS.map(loadOne));
      return lists.flat();
    },
  };
}

export function upsertNote(snapshotText: string | null, note: Note): string {
  let doc: Record<string, unknown> = { version: 1, notes: [] };
  let notes: Note[] = [];
  if (snapshotText !== null) {
    try {
      const parsed: unknown = JSON.parse(snapshotText);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        Array.isArray((parsed as { notes?: unknown }).notes)
      ) {
        doc = parsed as Record<string, unknown>;
        notes = (doc.notes as unknown[]).filter(isNote);
      }
    } catch {
      // unreadable input starts a new snapshot
    }
  }
  const merged = notes.filter((n) => n.path !== note.path);
  merged.push(note);
  merged.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify({ ...doc, version: 1, notes: merged });
}
