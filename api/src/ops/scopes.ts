import type { Note } from '../snapshot.ts';

export async function memoryScopes(deps: {
  snapshots: { load(): Promise<Note[]> };
}): Promise<{ scopes: Array<{ scope: string; notes: number }> }> {
  const counts = new Map<string, number>();
  for (const note of await deps.snapshots.load()) {
    const scope = note.path.slice(0, note.path.lastIndexOf('/'));
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  const scopes = [...counts].map(([scope, notes]) => ({ scope, notes }));
  scopes.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
  return { scopes };
}
