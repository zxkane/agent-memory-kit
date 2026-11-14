import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/errors.ts';
import { createSnapshots, listNotes, upsertNote, type Note } from '../src/snapshot.ts';
import { fakeStore } from './fake-store.ts';

const note = (path: string, extra: Partial<Note> = {}): Note => ({
  path,
  name: 'n',
  description: 'd',
  type: 'reference',
  body: 'b',
  ...extra,
});

const doc = (notes: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, ...extra, notes });

test('load: both snapshots missing gives an empty list', async () => {
  assert.deepEqual(await createSnapshots(fakeStore()).load(), []);
});

test('load: combines both snapshots and ignores extra fields', async () => {
  const s = fakeStore({
    'index/mem.json': doc([note('global/a.md'), note('projects/x/b.md')], { commit: 'abc' }),
    'index/agents.json': doc([note('agents/bot/c.md')]),
  });
  const paths = (await createSnapshots(s).load()).map((n) => n.path).sort();
  assert.deepEqual(paths, ['agents/bot/c.md', 'global/a.md', 'projects/x/b.md']);
});

test('load: second call sends the etag and reuses the parsed list on not-modified', async () => {
  const s = fakeStore({ 'index/mem.json': doc([note('global/a.md')]) });
  const snaps = createSnapshots(s);
  const first = await snaps.load();
  s.gets.length = 0;
  const second = await snaps.load();
  assert.deepEqual(second, first);
  const memGet = s.gets.find((g) => g.key === 'index/mem.json');
  assert.equal(memGet?.ifNoneMatch, s.objects.get('index/mem.json')?.etag);
});

test('load: a changed object is re-parsed', async () => {
  const s = fakeStore({ 'index/mem.json': doc([note('global/a.md')]) });
  const snaps = createSnapshots(s);
  await snaps.load();
  await s.put('index/mem.json', doc([note('global/z.md')]), null);
  assert.deepEqual((await snaps.load()).map((n) => n.path), ['global/z.md']);
});

test('load: an object deleted after caching becomes empty', async () => {
  const s = fakeStore({ 'index/mem.json': doc([note('global/a.md')]) });
  const snaps = createSnapshots(s);
  await snaps.load();
  s.objects.delete('index/mem.json');
  assert.deepEqual(await snaps.load(), []);
});

test('load: unreadable snapshots throw 500 internal', async () => {
  for (const text of ['not json', '{"version":1}', '{"notes":{}}', 'null']) {
    const s = fakeStore({ 'index/mem.json': text });
    await assert.rejects(
      () => createSnapshots(s).load(),
      (err: unknown) =>
        err instanceof ApiError &&
        err.status === 500 &&
        err.code === 'internal' &&
        err.message === 'the search snapshot is unreadable',
    );
  }
});

test('load: malformed entries and bad paths are skipped', async () => {
  const s = fakeStore({
    'index/mem.json': doc([
      note('global/ok.md'),
      null,
      'str',
      { path: 'global/x.md', name: 'n', description: 'd', type: 't' },
      note('global/x.md', { body: 5 as unknown as string }),
      note('../etc/passwd.md'),
      note('global/sub/dir.md'),
      note('nope.md'),
    ]),
  });
  assert.deepEqual((await createSnapshots(s).load()).map((n) => n.path), ['global/ok.md']);
});

test('upsertNote: starts a new snapshot from null', () => {
  const out = JSON.parse(upsertNote(null, note('global/a.md')));
  assert.deepEqual(out, { version: 1, notes: [note('global/a.md')] });
});

test('upsertNote and listNotes: unreadable text throws 500 internal', () => {
  for (const input of ['garbage', '{"notes":3}', '{"notes":5}', '{"version":1}', 'null', '[]', '{"notes":[']) {
    for (const fn of [() => upsertNote(input, note('global/a.md')), () => listNotes(input)]) {
      assert.throws(
        fn,
        (err: unknown) =>
          err instanceof ApiError &&
          err.status === 500 &&
          err.code === 'internal' &&
          err.message === 'the search snapshot is unreadable',
      );
    }
  }
});

test('upsertNote: malformed entries survive unchanged', () => {
  const odd = [null, 'str', { path: 'global/x.md', name: 'n' }, 7];
  const out = JSON.parse(upsertNote(doc([...odd, note('global/b.md')]), note('global/a.md'))) as { notes: unknown[] };
  assert.deepEqual(out.notes, [note('global/a.md'), note('global/b.md'), ...odd]);
});

test('upsertNote: adds, replaces by path and sorts', () => {
  let text = upsertNote(null, note('projects/x/b.md'));
  text = upsertNote(text, note('agents/bot/a.md'));
  text = upsertNote(text, note('global/c.md'));
  text = upsertNote(text, note('global/c.md', { body: 'new' }));
  const parsed = JSON.parse(text) as { version: number; notes: Note[] };
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.notes.map((n) => n.path), ['agents/bot/a.md', 'global/c.md', 'projects/x/b.md']);
  assert.equal(parsed.notes[1]?.body, 'new');
});

test('upsertNote: preserves extra top-level fields', () => {
  const text = upsertNote(doc([], { commit: 'abc' }), note('global/a.md'));
  assert.equal((JSON.parse(text) as { commit: string }).commit, 'abc');
});

test('load: each snapshot keeps only its own scope kinds', async () => {
  const s = fakeStore({
    'index/mem.json': doc([note('global/a.md'), note('projects/x/b.md'), note('agents/bot/evil.md')]),
    'index/agents.json': doc([note('agents/bot/c.md'), note('global/evil.md'), note('projects/x/evil.md')]),
  });
  const paths = (await createSnapshots(s).load()).map((n) => n.path).sort();
  assert.deepEqual(paths, ['agents/bot/c.md', 'global/a.md', 'projects/x/b.md']);
});
