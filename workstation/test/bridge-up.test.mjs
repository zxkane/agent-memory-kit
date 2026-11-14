import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AwsError } from '../lib/aws.mjs';
import { buildSnapshot, isMemPath, runBridgeUp } from '../lib/bridge-up.mjs';
import { createS3 } from '../lib/s3.mjs';
import { git } from '../lib/git.mjs';
import { createFakeS3 } from './fake-s3.mjs';
import { isolateGit, makeRemoteAndClones, sh, tempDir } from './helpers.mjs';

isolateGit();

const credentials = { accessKeyId: 'EXAMPLEKEYID', secretAccessKey: 'example-signing-value', sessionToken: 'example-session-value' };
const SECRET = 'TO' + 'KEN=abcDEF1234567890abcDEF1234567890ab';
const NOW = new Date('2026-11-14T10:00:00Z');
const md5 = (s) => `"${createHash('md5').update(s).digest('hex')}"`;
const REC = 'index/bridge.json';

const NOTE = '---\nname: user-pref\ndescription: How the user likes answers\nmetadata:\n  type: user\n---\n\nShort answers.\n';

function write(dir, rel, content) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

// Writes and removes files, then commits them.
// The commit also becomes origin/main of that clone (as after a sync), unless `track` is false.
function commit(dir, files = {}, removes = [], message = 'sync(alpha): notes', track = true) {
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  for (const rel of removes) rmSync(join(dir, rel));
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-m', message]);
  const head = sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
  if (track) sh(dir, 'git', ['update-ref', 'refs/remotes/origin/main', head]);
  return head;
}

function fixture(t, { fetchWrap, pageSize } = {}) {
  const { a, b, remote } = makeRemoteAndClones(t);
  const fake = createFakeS3({ pageSize });
  const stateDir = join(tempDir(t), 'state');
  const controller = new AbortController();
  const s3 = createS3({
    bucket: 'example-bucket', region: 'ap-northeast-1', credentials,
    fetchImpl: fetchWrap ? fetchWrap(fake.fetch) : fake.fetch,
    now: () => NOW, sleep: async () => {}, signal: controller.signal,
  });
  const config = {
    host: 'alpha', repoDir: a, repoUrl: null, stateDir, claudeDir: '/unused', staleAfterSeconds: 600,
    bridge: { bucket: 'example-bucket', region: 'ap-northeast-1', up: true, down: false, agentsRepoDir: null, agentsRepoUrl: null },
  };
  const run = (opts = {}) => runBridgeUp({ config, s3, now: NOW, signal: controller.signal, ...opts });
  const stateFile = join(stateDir, 'bridge.json');
  const record = () => (fake.objects.has(REC) ? JSON.parse(fake.objects.get(REC).body.toString()) : null);
  const snapshot = () => JSON.parse(fake.objects.get('index/mem.json').body.toString());
  const memKeys = () => [...fake.objects.keys()].filter((k) => k.startsWith('mem/')).sort();
  return { a, b, remote, fake, s3, config, run, stateDir, stateFile, record, snapshot, memKeys, controller };
}

const mutating = (fake, from = 0) => fake.requests.slice(from).filter((r) => r.method === 'PUT' || r.method === 'DELETE');

test('isMemPath accepts the API shapes only', () => {
  for (const p of ['global/a.md', 'global/MEMORY.md', 'projects/demo.app/a-b_c.md', 'projects/p1/MEMORY.md']) assert.equal(isMemPath(p), true, p);
  for (const p of ['.project', '_reports/x.md', 'projects/p/sub/x.md', 'projects/p/notes.txt', 'projects/p/with space.md',
    'global/.hidden.md', 'global/a.md/', 'global//a.md', 'projects/../a.md', 'projects/.x/a.md', 'other/a.md', 'global/a\n.md',
    'projects/p/a.md\n', 'global', 'projects/p', '']) {
    assert.equal(isMemPath(p), false, JSON.stringify(p));
  }
  assert.equal(isMemPath(undefined), false);
});

test('1. first run: only mem paths are uploaded, the snapshot has the notes, the record is created', async (t) => {
  const f = fixture(t);
  const head = commit(f.a, {
    'global/user.md': NOTE,
    'global/MEMORY.md': '- [user](user.md)\n',
    'projects/demo.app/plain.md': 'Just text, no frontmatter.\n',
    'projects/demo.app/MEMORY.md': '- [plain](plain.md)\n',
    '.project': 'x',
    'projects/demo.app/.project': 'x',
    '_reports/x.md': 'x',
    'projects/p/sub/x.md': 'x',
    'projects/p/notes.txt': 'x',
    'projects/p/with space.md': 'x',
    'global/odd\nname.md': 'x',
  });
  const result = await f.run();
  assert.deepEqual(result, { status: 'uploaded', commit: head, full: true, puts: 4, deletes: 0, foreign: 0, snapshotBytes: f.fake.objects.get('index/mem.json').body.length, bodyLimit: 100000, skipped: [] });
  assert.deepEqual(f.memKeys(), [
    'mem/global/MEMORY.md', 'mem/global/user.md', 'mem/projects/demo.app/MEMORY.md', 'mem/projects/demo.app/plain.md',
  ]);
  assert.equal(f.fake.objects.get('mem/global/user.md').body.toString(), NOTE);
  const snap = f.snapshot();
  assert.equal(snap.version, 1);
  assert.equal(snap.commit, head);
  assert.deepEqual(snap.notes, [
    { path: 'global/user.md', name: 'user-pref', description: 'How the user likes answers', type: 'user', body: 'Short answers.\n' },
    { path: 'projects/demo.app/plain.md', name: 'plain', description: '', type: '', body: 'Just text, no frontmatter.\n' },
  ]);
  const putRecord = f.fake.requests.find((r) => r.method === 'PUT' && r.key === REC);
  assert.equal(putRecord.headers['if-none-match'], '*');
  assert.equal(putRecord.headers['if-match'], undefined);
  assert.equal(f.fake.requests.at(-1), putRecord);
  assert.deepEqual(f.record(), { version: 1, commit: head, host: 'alpha', time: NOW.toISOString() });
  assert.equal(f.fake.requests.find((r) => r.key === 'index/mem.json').headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(readFileSync(f.stateFile, 'utf8')), { up: { commit: head, checkedAt: NOW.toISOString() } });
});

test('2. a second run makes no request at all', async (t) => {
  const f = fixture(t);
  const head = commit(f.a, { 'global/user.md': NOTE });
  await f.run();
  const before = f.fake.requests.length;
  const again = await f.run();
  assert.deepEqual(again, { status: 'unchanged', commit: head, full: false, puts: 0, deletes: 0, foreign: 0, snapshotBytes: 0, bodyLimit: 0, skipped: [] });
  assert.equal(f.fake.requests.length, before);
});

test('3. a delta: one change, one addition and one removal give two puts and one delete, then snapshot, then record', async (t) => {
  const f = fixture(t);
  commit(f.a, { 'global/one.md': 'one\n', 'global/two.md': 'two\n', 'global/three.md': 'three\n' });
  await f.run();
  const head = commit(f.a, { 'global/one.md': 'one changed\n', 'global/four.md': 'four\n' }, ['global/three.md']);
  const mark = f.fake.requests.length;
  const etagBefore = f.fake.objects.get(REC).etag;
  const result = await f.run();
  assert.deepEqual(result, { status: 'uploaded', commit: head, full: false, puts: 2, deletes: 1, foreign: 0, snapshotBytes: f.fake.objects.get('index/mem.json').body.length, bodyLimit: 100000, skipped: [] });
  const sent = f.fake.requests.slice(mark).map((r) => `${r.method} ${r.key}`);
  assert.equal(sent[0], `GET ${REC}`);
  assert.deepEqual(sent.slice(1, 3).sort(), ['PUT mem/global/four.md', 'PUT mem/global/one.md']);
  assert.deepEqual(sent.slice(3), ['PUT index/mem.json', 'DELETE mem/global/three.md', `PUT ${REC}`]);
  assert.equal(f.fake.requests.at(-1).headers['if-match'], etagBefore);
  assert.equal(f.record().commit, head);
  assert.deepEqual(f.memKeys(), ['mem/global/four.md', 'mem/global/one.md', 'mem/global/two.md']);
  assert.deepEqual(f.snapshot().notes.map((n) => n.path), ['global/four.md', 'global/one.md', 'global/two.md']);
});

test('4. a change only in the working tree is not uploaded', async (t) => {
  const f = fixture(t);
  commit(f.a, { 'global/one.md': 'committed text\n' });
  write(f.a, 'global/one.md', 'working tree text\n');
  write(f.a, 'global/untracked.md', 'never committed\n');
  await f.run();
  assert.equal(f.fake.objects.get('mem/global/one.md').body.toString(), 'committed text\n');
  assert.deepEqual(f.memKeys(), ['mem/global/one.md']);
  assert.deepEqual(f.snapshot().notes.map((n) => n.body), ['committed text\n']);
});

test('5. a record naming an unknown commit: fetch, then a full upload that deletes stale keys and skips equal ones', async (t) => {
  const f = fixture(t);
  const head5 = commit(f.a, { 'global/one.md': 'one\n', 'global/two.md': 'two\n' });
  await f.run();
  // This clone's history is on the remote; another machine adds a commit that this clone does not have.
  sh(f.a, 'git', ['push', 'origin', 'main']);
  sh(f.b, 'git', ['pull', '--ff-only', 'origin', 'main']);
  const other = commit(f.b, { 'global/remote.md': 'remote\n' });
  sh(f.b, 'git', ['push', 'origin', 'main']);
  await f.s3.put(REC, JSON.stringify({ version: 1, commit: 'f'.repeat(40), host: 'beta', time: NOW.toISOString() }));
  await f.s3.put('mem/global/gone.md', 'stale');
  await f.s3.put('mem/projects/p/sub/x.md', 'stale');
  const mark = f.fake.requests.length;
  const result = await f.run({ recheckMs: 0 });
  // The fetch brought the objects but did not move origin/main.
  assert.equal(sh(f.a, 'git', ['rev-parse', 'refs/remotes/origin/main']).trim(), head5);
  sh(f.a, 'git', ['cat-file', '-e', `${other}^{commit}`]);
  assert.equal(result.status, 'uploaded');
  assert.equal(result.full, true);
  assert.equal(result.puts, 0);
  assert.equal(result.deletes, 1);
  assert.equal(result.foreign, 1);
  assert.deepEqual(mutating(f.fake, mark).map((r) => `${r.method} ${r.key}`).filter((x) => x.startsWith('DELETE')), ['DELETE mem/global/gone.md']);
  // A key that is not a mem path is left alone.
  assert.deepEqual(f.memKeys(), ['mem/global/one.md', 'mem/global/two.md', 'mem/projects/p/sub/x.md']);
});

test('6. a record naming a newer commit of which head is an ancestor: behind, nothing written', async (t) => {
  const f = fixture(t);
  const c1 = commit(f.a, { 'global/one.md': 'one\n' });
  const c2 = commit(f.a, { 'global/two.md': 'two\n' });
  await f.s3.put(REC, JSON.stringify({ version: 1, commit: c2, host: 'beta', time: NOW.toISOString() }));
  sh(f.a, 'git', ['reset', '--hard', c1]);
  sh(f.a, 'git', ['update-ref', 'refs/remotes/origin/main', c1]);
  const mark = f.fake.requests.length;
  const result = await f.run();
  assert.deepEqual(result, { status: 'behind', commit: c1, full: false, puts: 0, deletes: 0, foreign: 0, snapshotBytes: 0, bodyLimit: 0, skipped: [] });
  assert.deepEqual(mutating(f.fake, mark), []);
  assert.equal(f.record().commit, c2);
  assert.equal(existsSync(f.stateFile), false);
});

test('7. the record changes between the read and the write: raced, local state unchanged', async (t) => {
  const f = fixture(t);
  commit(f.a, { 'global/one.md': 'one\n' });
  await f.run();
  const stateBefore = readFileSync(f.stateFile, 'utf8');
  const head = commit(f.a, { 'global/two.md': 'two\n' });
  let moved = false;
  f.fake.onRequest(({ method, key }) => {
    if (moved || method !== 'PUT' || !key.startsWith('mem/')) return;
    moved = true;
    const body = Buffer.from(JSON.stringify({ version: 1, commit: 'e'.repeat(40), host: 'beta', time: NOW.toISOString() }));
    f.fake.objects.set(REC, { body, etag: md5(body) });
  });
  const result = await f.run();
  assert.equal(result.status, 'raced');
  assert.equal(result.commit, head);
  assert.equal(f.record().commit, 'e'.repeat(40));
  assert.equal(readFileSync(f.stateFile, 'utf8'), stateBefore);
});

test('8. a note the secret scan flags is skipped, left out of the snapshot and removed from mem/', async (t) => {
  const f = fixture(t);
  commit(f.a, { 'projects/p/x.md': 'clean\n', 'projects/p/y.md': 'fine\n' });
  await f.run();
  assert.ok(f.fake.objects.has('mem/projects/p/x.md'));
  const head = commit(f.a, { 'projects/p/x.md': `now with\n${SECRET}\n`, 'projects/p/z.md': `${SECRET}\n` });
  const result = await f.run();
  assert.equal(result.status, 'uploaded');
  assert.deepEqual(result.skipped, [{ path: 'projects/p/x.md', reason: 'flagged' }, { path: 'projects/p/z.md', reason: 'flagged' }]);
  assert.deepEqual(f.memKeys(), ['mem/projects/p/y.md']);
  assert.deepEqual(f.snapshot().notes.map((n) => n.path), ['projects/p/y.md']);
  assert.equal(f.record().commit, head);
  for (const object of f.fake.objects.values()) assert.ok(!object.body.toString().includes(SECRET));
  assert.ok(f.fake.requests.every((r) => !r.url.includes('abcDEF')));
});

test('9. a put that fails three times throws and records nothing; the next run records', async (t) => {
  const f = fixture(t);
  const head = commit(f.a, { 'global/one.md': 'one\n' });
  let armed = true;
  f.fake.onRequest(({ method, key }) => {
    if (armed && method === 'PUT' && key.startsWith('mem/')) { armed = false; f.fake.failNext(3, 500); }
  });
  await assert.rejects(f.run(), (err) => {
    assert.ok(err instanceof AwsError);
    assert.equal(err.message, 'put failed: 500 ServiceUnavailable');
    return true;
  });
  assert.equal(f.record(), null);
  assert.equal(existsSync(f.stateFile), false);
  const result = await f.run();
  assert.equal(result.status, 'uploaded');
  assert.equal(f.record().commit, head);
});

test('10. with recheckMs 0 and a record moved back to an older commit, the delta is sent again', async (t) => {
  const f = fixture(t);
  const c1 = commit(f.a, { 'global/one.md': 'one\n' });
  await f.run();
  const c2 = commit(f.a, { 'global/two.md': 'two\n' });
  await f.run();
  const body = JSON.stringify({ version: 1, commit: c1, host: 'beta', time: NOW.toISOString() });
  await f.s3.put(REC, body);
  f.fake.objects.delete('mem/global/two.md');
  const result = await f.run({ recheckMs: 0 });
  assert.deepEqual(result, { status: 'uploaded', commit: c2, full: false, puts: 1, deletes: 0, foreign: 0, snapshotBytes: f.fake.objects.get('index/mem.json').body.length, bodyLimit: 100000, skipped: [] });
  assert.ok(f.fake.objects.has('mem/global/two.md'));
  assert.equal(f.record().commit, c2);
});

test('10b. within recheckMs the local state is believed without a request; after it, a verification pass', async (t) => {
  const f = fixture(t);
  commit(f.a, { 'global/one.md': 'one\n' });
  await f.run();
  const mark = f.fake.requests.length;
  const later = new Date(NOW.getTime() + 3_599_000);
  assert.equal((await f.run({ now: later })).status, 'unchanged');
  assert.equal(f.fake.requests.length, mark);
  const muchLater = new Date(NOW.getTime() + 3_600_000);
  assert.equal((await f.run({ now: muchLater })).status, 'verified');
  assert.deepEqual(f.fake.requests.slice(mark).map((r) => r.method + ' ' + r.key), [`GET ${REC}`, 'GET ', 'PUT index/mem.json']);
  // The verification time was saved.
  const mark2 = f.fake.requests.length;
  assert.equal((await f.run({ now: new Date(muchLater.getTime() + 1000) })).status, 'unchanged');
  assert.equal(f.fake.requests.length, mark2);
  // A recorded time in the future is not trusted.
  const earlier = new Date(NOW.getTime() - 60_000);
  assert.equal((await f.run({ now: earlier })).status, 'verified');
});

test('11. a record that is not JSON: full upload, replaced with if-match on its ETag', async (t) => {
  const f = fixture(t);
  const head = commit(f.a, { 'global/one.md': 'one\n' });
  await f.s3.put(REC, 'not json');
  const result = await f.run();
  assert.equal(result.status, 'uploaded');
  assert.equal(result.full, true);
  assert.equal(f.fake.requests.at(-1).headers['if-match'], md5('not json'));
  assert.equal(f.record().commit, head);
});

test('11b. a record of the wrong shape is replaced the same way', async (t) => {
  const f = fixture(t);
  const head = commit(f.a, { 'global/one.md': 'one\n' });
  for (const bad of ['{"version":1,"commit":"--upload-pack=x","host":"b","time":"t"}', '{"version":2,"commit":"' + 'a'.repeat(40) + '"}', '[]', 'null']) {
    await f.s3.put(REC, bad);
    const result = await f.run({ recheckMs: 0 });
    assert.equal(result.full, true, bad);
    assert.equal(f.fake.requests.at(-1).headers['if-match'], md5(bad), bad);
    assert.equal(f.record().commit, head);
  }
});

test('12. a 150,000-byte note is uploaded whole and cut in the snapshot; 1,000,001 bytes is skipped', async (t) => {
  const f = fixture(t);
  const big = '日'.repeat(50_000);
  const huge = 'x'.repeat(1_000_001);
  commit(f.a, { 'global/big.md': big, 'global/huge.md': huge });
  const result = await f.run();
  assert.deepEqual(result.skipped, [{ path: 'global/huge.md', reason: 'too-large' }]);
  assert.equal(result.puts, 1);
  assert.equal(f.fake.objects.get('mem/global/big.md').body.length, 150_000);
  assert.deepEqual(f.memKeys(), ['mem/global/big.md']);
  const { body } = f.snapshot().notes[0];
  const bytes = Buffer.byteLength(body, 'utf8');
  assert.ok(bytes <= 100_000 && bytes > 99_990, String(bytes));
  assert.ok(!body.includes('�'));
  assert.ok(big.startsWith(body));
});

test('13. the record is unreadable (403) while it exists: the run uploads, the record put conflicts, raced', async (t) => {
  const f = fixture(t, {
    fetchWrap: (real) => async (url, init) => {
      const u = new URL(url);
      if ((init?.method ?? 'GET') === 'GET' && u.pathname === `/${REC}`) return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
      return real(url, init);
    },
  });
  commit(f.a, { 'global/one.md': 'one\n' });
  const existing = JSON.stringify({ version: 1, commit: 'd'.repeat(40), host: 'beta', time: NOW.toISOString() });
  await f.s3.put(REC, existing);
  const result = await f.run();
  assert.equal(result.status, 'raced');
  assert.equal(result.full, true);
  assert.ok(f.fake.objects.has('mem/global/one.md'));
  assert.equal(f.fake.objects.get(REC).body.toString(), existing);
  assert.equal(existsSync(f.stateFile), false);
});

test('14. a fired signal stops the run with TimeLimit and records nothing', async (t) => {
  const f = fixture(t);
  commit(f.a, { 'global/one.md': 'one\n', 'global/two.md': 'two\n' });
  f.controller.abort();
  await assert.rejects(f.run(), (err) => err instanceof AwsError && err.operation === 'bridge-up' && err.status === 0 && err.code === 'TimeLimit');
  assert.equal(f.fake.requests.length, 0);

  const g = fixture(t);
  commit(g.a, { 'global/one.md': 'one\n', 'global/two.md': 'two\n' });
  g.fake.onRequest(({ method, key }) => { if (method === 'PUT' && key.startsWith('mem/')) g.controller.abort(); });
  await assert.rejects(g.run(), (err) => err instanceof AwsError && err.code === 'TimeLimit');
  assert.equal(g.record(), null);
  assert.equal(g.fake.objects.has('index/mem.json'), false);
  assert.equal(existsSync(g.stateFile), false);
});

test('15. the local state keeps keys it does not own, is private and is written atomically', async (t) => {
  const f = fixture(t);
  mkdirSync(f.stateDir, { recursive: true });
  writeFileSync(f.stateFile, JSON.stringify({ other: { keep: 1 }, up: 'junk' }));
  commit(f.a, { 'global/one.md': 'one\n' });
  const head = sh(f.a, 'git', ['rev-parse', 'HEAD']).trim();
  await f.run();
  assert.deepEqual(JSON.parse(readFileSync(f.stateFile, 'utf8')), { other: { keep: 1 }, up: { commit: head, checkedAt: NOW.toISOString() } });
  assert.equal(statSync(f.stateFile).mode & 0o777, 0o600);
  assert.deepEqual(sh(f.stateDir, 'ls').trim().split('\n'), ['bridge.json']);

  const g = fixture(t);
  commit(g.a, { 'global/one.md': 'one\n' });
  await g.run();
  assert.equal(statSync(g.stateDir).mode & 0o777, 0o700);
  writeFileSync(g.stateFile, '{ not json');
  commit(g.a, { 'global/two.md': 'two\n' });
  await g.run();
  assert.equal(JSON.parse(readFileSync(g.stateFile, 'utf8')).up.commit, sh(g.a, 'git', ['rev-parse', 'HEAD']).trim());
});

test('16. at most eight requests are in flight', async (t) => {
  let inFlight = 0;
  let peak = 0;
  const f = fixture(t, {
    fetchWrap: (real) => async (url, init) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await real(url, init);
      } finally { inFlight -= 1; }
    },
  });
  const files = {};
  for (let i = 0; i < 40; i++) files[`global/n${i}.md`] = `note ${i}\n`;
  commit(f.a, files);
  const result = await f.run();
  assert.equal(result.puts, 40);
  assert.ok(peak > 1 && peak <= 8, String(peak));
});

test('17. a symlink named like a note and a path with a newline are never uploaded', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.a, 'global'), { recursive: true });
  symlinkSync('/etc/hostname', join(f.a, 'global/link.md'));
  commit(f.a, { 'global/real.md': 'real\n', 'global/a\nb.md': 'x', 'projects/p/x\ty.md': 'x' });
  const result = await f.run();
  assert.equal(result.puts, 1);
  assert.deepEqual(f.memKeys(), ['mem/global/real.md']);
  assert.deepEqual(f.snapshot().notes.map((n) => n.path), ['global/real.md']);
});

test('18. buildSnapshot reads the commit, honours the skip set and cuts a body on a character boundary', async (t) => {
  const f = fixture(t);
  const head = commit(f.a, { 'global/a.md': '---\nname: A\n---\nbody a\n', 'global/b.md': 'body b\n', 'global/MEMORY.md': 'index\n' });
  write(f.a, 'global/a.md', 'changed in the working tree');
  const snap = JSON.parse(buildSnapshot(f.a, head, new Set(['global/b.md'])));
  assert.deepEqual(snap, { version: 1, commit: head, notes: [{ path: 'global/a.md', name: 'A', description: '', type: '', body: 'body a\n' }] });
  assert.deepEqual(JSON.parse(buildSnapshot(f.a, head)).notes.map((n) => n.path), ['global/a.md', 'global/b.md']);
});

test('19. a frontmatter block that is not closed is part of the body', async (t) => {
  const f = fixture(t);
  commit(f.a, { 'global/open.md': '---\nname: x\nnever closed\n' });
  await f.run();
  assert.deepEqual(f.snapshot().notes, [
    { path: 'global/open.md', name: 'open', description: '', type: '', body: '---\nname: x\nnever closed\n' },
  ]);
});

test('20. a Git failure throws and records nothing', async (t) => {
  const f = fixture(t);
  commit(f.a, { 'global/one.md': 'one\n' });
  f.config.repoDir = join(tempDir(t), 'not-a-repo');
  mkdirSync(f.config.repoDir);
  await assert.rejects(f.run());
  assert.equal(f.fake.requests.length, 0);
  assert.equal(existsSync(f.stateFile), false);
});

test('21. not-synced: a commit that is not origin/main is never sent', async (t) => {
  const f = fixture(t);
  const head = commit(f.a, { 'global/one.md': 'one\n' }, [], 'local only', false);
  const result = await f.run();
  assert.equal(result.status, 'not-synced');
  assert.equal(result.commit, head);
  assert.equal(f.fake.requests.length, 0);
  assert.equal(existsSync(f.stateFile), false);
  sh(f.a, 'git', ['update-ref', '-d', 'refs/remotes/origin/main']);
  assert.equal((await f.run()).status, 'not-synced');
  assert.equal(f.fake.requests.length, 0);
});

test('22. a verification on a consistent bucket: one list per page, one snapshot put, nothing else', async (t) => {
  const f = fixture(t, { pageSize: 2 });
  commit(f.a, { 'global/a.md': 'a\n', 'global/b.md': 'b\n', 'global/c.md': 'c\n' });
  await f.run();
  const mark = f.fake.requests.length;
  const result = await f.run({ recheckMs: 0 });
  assert.equal(result.status, 'verified');
  assert.equal(result.puts + result.deletes, 0);
  assert.equal(result.full, false);
  assert.deepEqual(f.fake.requests.slice(mark).map((r) => `${r.method} ${r.key}`), [`GET ${REC}`, 'GET ', 'GET ', 'PUT index/mem.json']);
});

test('23. two bridges interleaved: the older one overwrites after the newer one recorded; the newer one repairs on its next run', async (t) => {
  const f = fixture(t);
  // B is clone b at C1; A is clone a at C2, a descendant of C1.
  const c1 = commit(f.b, { 'global/x.md': 'old content\n' });
  sh(f.b, 'git', ['push', 'origin', 'main']);
  sh(f.a, 'git', ['pull', '--ff-only', 'origin', 'main']);
  const c2 = commit(f.a, { 'global/x.md': 'new content\n', 'global/added.md': 'added\n' });
  const stateB = join(tempDir(t), 'state-b');
  const configB = { ...f.config, repoDir: f.b, stateDir: stateB, host: 'beta' };
  const newer = () => f.run();
  const olderSigner = new AbortController();
  const s3Older = createS3({
    bucket: 'example-bucket', region: 'ap-northeast-1', credentials, now: () => NOW, sleep: async () => {}, signal: olderSigner.signal,
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      if (!moved && init?.method === 'PUT' && u.pathname.startsWith('/mem/')) {
        moved = true;
        assert.equal((await newer()).status, 'uploaded');
      }
      return f.fake.fetch(url, init);
    },
  });
  let moved = false;
  const older = await runBridgeUp({ config: configB, s3: s3Older, now: NOW, signal: olderSigner.signal });
  assert.equal(older.status, 'raced');
  assert.equal(older.commit, c1);
  // The bucket now mixes both: the record names C2, the content is C1's.
  assert.equal(f.record().commit, c2);
  assert.equal(f.fake.objects.get('mem/global/x.md').body.toString(), 'old content\n');
  assert.equal(f.snapshot().commit, c1);
  const recordBefore = f.fake.objects.get(REC).body.toString();
  const healed = await f.run({ recheckMs: 0 });
  assert.equal(healed.status, 'repaired');
  assert.ok(healed.puts >= 1);
  assert.equal(f.fake.objects.get('mem/global/x.md').body.toString(), 'new content\n');
  assert.equal(f.snapshot().commit, c2);
  assert.deepEqual(f.snapshot().notes.map((n) => n.path), ['global/added.md', 'global/x.md']);
  assert.equal(f.fake.objects.get(REC).body.toString(), recordBefore);
});

test('24. a key under mem/ that is not a mem path is left alone and counted', async (t) => {
  const f = fixture(t);
  commit(f.a, { 'global/one.md': 'one\n' });
  for (const key of ['mem/global/with space.md', 'mem/odd/x.md']) f.fake.objects.set(key, { body: Buffer.from('x'), etag: md5('x') });
  const result = await f.run();
  assert.equal(result.status, 'uploaded');
  assert.equal(result.full, true);
  assert.equal(result.foreign, 2);
  assert.equal(result.deletes, 0);
  assert.ok(f.fake.objects.has('mem/global/with space.md') && f.fake.objects.has('mem/odd/x.md'));
  assert.equal(f.record().commit, sh(f.a, 'git', ['rev-parse', 'HEAD']).trim());
});

test('25. in a delta, an unchanged note that is now flagged is deleted and left out of the snapshot', async (t) => {
  const f = fixture(t);
  commit(f.a, { 'global/keep.md': 'keep\n', 'global/odd.md': 'odd one\n' });
  await f.run();
  assert.ok(f.fake.objects.has('mem/global/odd.md'));
  commit(f.a, { 'global/keep.md': 'keep changed\n' });
  const scan = (text) => (text.includes('odd one') ? [{ id: 'fake', line: 1 }] : []);
  const result = await f.run({ scan });
  assert.equal(result.full, false);
  assert.deepEqual(result.skipped, [{ path: 'global/odd.md', reason: 'flagged' }]);
  assert.equal(f.fake.objects.has('mem/global/odd.md'), false);
  assert.deepEqual(f.snapshot().notes.map((n) => n.path), ['global/keep.md']);
});

function bigCorpus(f, count) {
  const files = {};
  for (let i = 0; i < count; i++) files[`global/n${String(i).padStart(2, '0')}.md`] = `${'abcdefghi '.repeat(10_000)}\n`;
  commit(f.a, files);
}

test('26. the snapshot is cut to fit: a small corpus keeps 100,000, one reduction, several reductions, and one that cannot fit', async (t) => {
  const small = fixture(t);
  bigCorpus(small, 3);
  assert.equal((await small.run()).bodyLimit, 100_000);

  const one = fixture(t);
  bigCorpus(one, 20);
  const r1 = await one.run({ snapshotMaxBytes: 1_500_000 });
  assert.equal(r1.bodyLimit, 56_250);
  assert.ok(r1.snapshotBytes <= 1_500_000);
  assert.equal(one.fake.objects.get('index/mem.json').body.length, r1.snapshotBytes);
  assert.equal(one.snapshot().notes[0].body.length, 56_250);

  const several = fixture(t);
  bigCorpus(several, 20);
  const r2 = await several.run({ snapshotMaxBytes: 600_000 });
  assert.equal(r2.bodyLimit, 23_730);
  assert.ok(r2.snapshotBytes <= 600_000);
  assert.equal(several.fake.objects.get('mem/global/n00.md').body.length, 100_001);

  const none = fixture(t);
  bigCorpus(none, 20);
  await assert.rejects(none.run({ snapshotMaxBytes: 10_000 }), (err) => err instanceof AwsError && err.code === 'SnapshotTooLarge' && err.operation === 'bridge-up');
  assert.equal(none.fake.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE').length, 0);
  assert.equal(none.record(), null);
  assert.equal(existsSync(none.stateFile), false);
});

test('27. git(): a string input works together with buffer: true', async (t) => {
  const f = fixture(t);
  const head = commit(f.a, { 'global/one.md': 'one\n' });
  const out = git(f.a, ['cat-file', '--batch-check'], { input: 'HEAD\n', buffer: true }).stdout;
  assert.ok(Buffer.isBuffer(out));
  assert.match(out.toString(), new RegExp(`^${head} commit \\d+\n$`));
  const text = git(f.a, ['cat-file', '--batch-check'], { input: 'HEAD\n' }).stdout;
  assert.equal(typeof text, 'string');
});

test('28. a rewritten remote: diverged, nothing sent; bridge up fetches objects but moves no ref, index or file', async (t) => {
  const f = fixture(t);
  const head = commit(f.a, { 'global/one.md': 'one\n' });
  sh(f.a, 'git', ['push', 'origin', 'main']);
  // Another clone rewrites history and force-updates the remote.
  sh(f.b, 'git', ['reset', '--hard', 'HEAD']);
  const rewritten = commit(f.b, { 'global/other.md': 'other\n' });
  sh(f.b, 'git', ['push', '--force', 'origin', 'main']);
  await f.s3.put(REC, JSON.stringify({ version: 1, commit: rewritten, host: 'beta', time: NOW.toISOString() }));
  const snapshotOf = () => ({
    tracking: sh(f.a, 'git', ['rev-parse', 'refs/remotes/origin/main']), head: sh(f.a, 'git', ['rev-parse', 'HEAD']),
    index: sh(f.a, 'git', ['ls-files', '-s']), status: sh(f.a, 'git', ['status', '--porcelain']),
    refs: sh(f.a, 'git', ['for-each-ref']),
  });
  const before = snapshotOf();
  assert.equal(before.status, '');
  const recordBefore = f.fake.objects.get(REC).body.toString();
  const result = await f.run();
  assert.equal(result.commit, head);
  // The histories diverge: nothing is sent, recorded or saved.
  assert.equal(result.status, 'diverged');
  assert.deepEqual(mutating(f.fake, 1), []);
  assert.deepEqual([...f.fake.objects.keys()], [REC]);
  assert.equal(f.fake.objects.get(REC).body.toString(), recordBefore);
  assert.equal(existsSync(f.stateFile), false);
  assert.deepEqual(snapshotOf(), before);
  sh(f.a, 'git', ['cat-file', '-e', `${rewritten}^{commit}`]);
});

// Everything a bridge-up run must leave alone in the clone.
const cloneState = (dir) => ({
  tracking: sh(dir, 'git', ['rev-parse', 'refs/remotes/origin/main']), head: sh(dir, 'git', ['rev-parse', 'HEAD']),
  index: sh(dir, 'git', ['ls-files', '-s']), status: sh(dir, 'git', ['status', '--porcelain']),
});

test('29. a history purge done on the bridge machine itself: the record names abandoned history, a full upload replaces it', async (t) => {
  const f = fixture(t);
  commit(f.a, { 'global/keep.md': 'keep\n', 'global/purged.md': 'leaked\n' });
  sh(f.a, 'git', ['push', 'origin', 'main']);
  await f.run();
  assert.ok(f.fake.objects.has('mem/global/purged.md'));
  // Purge: rewrite history without the note and update the remote by force.
  sh(f.a, 'git', ['reset', '--hard', 'HEAD~1']);
  const head = commit(f.a, { 'global/keep.md': 'keep\n', 'global/new.md': 'new\n' });
  sh(f.a, 'git', ['push', '--force', 'origin', 'main']);
  const before = cloneState(f.a);
  const recordEtag = f.fake.objects.get(REC).etag;
  const result = await f.run({ recheckMs: 0 });
  assert.equal(result.status, 'uploaded');
  assert.equal(result.full, true);
  assert.equal(f.fake.objects.has('mem/global/purged.md'), false);
  assert.deepEqual(f.memKeys(), ['mem/global/keep.md', 'mem/global/new.md']);
  assert.deepEqual(f.snapshot().notes.map((n) => n.path), ['global/keep.md', 'global/new.md']);
  assert.equal(f.record().commit, head);
  assert.equal(f.fake.requests.at(-1).headers['if-match'], recordEtag);
  assert.deepEqual(cloneState(f.a), before);
});

test('30. a record that is neither behind nor ahead and an abandoned head: diverged, nothing written', async (t) => {
  const f = fixture(t);
  // Q is known to this clone but is in neither history that matters.
  const q = commit(f.a, { 'global/q.md': 'q\n' });
  sh(f.a, 'git', ['reset', '--hard', 'HEAD~1']);
  commit(f.a, { 'global/one.md': 'one\n' });
  commit(f.b, { 'global/y.md': 'y\n' });
  sh(f.b, 'git', ['push', '--force', 'origin', 'main']);
  await f.s3.put(REC, JSON.stringify({ version: 1, commit: q, host: 'beta', time: NOW.toISOString() }));
  const before = cloneState(f.a);
  const mark = f.fake.requests.length;
  const result = await f.run();
  assert.equal(result.status, 'diverged');
  assert.deepEqual(mutating(f.fake, mark), []);
  assert.deepEqual([...f.fake.objects.keys()], [REC]);
  assert.equal(existsSync(f.stateFile), false);
  assert.deepEqual(cloneState(f.a), before);
});

test('31. a recorded hash that names a tag is an unusable record: full upload, replaced with if-match', async (t) => {
  const f = fixture(t);
  const head = commit(f.a, { 'global/one.md': 'one\n' });
  sh(f.a, 'git', ['tag', '-a', '-m', 'marker', 'marker', head]);
  const tag = sh(f.a, 'git', ['rev-parse', 'marker']).trim();
  assert.notEqual(tag, head);
  const body = JSON.stringify({ version: 1, commit: tag, host: 'beta', time: NOW.toISOString() });
  await f.s3.put(REC, body);
  const result = await f.run();
  assert.equal(result.status, 'uploaded');
  assert.equal(result.full, true);
  assert.equal(f.fake.requests.at(-1).headers['if-match'], md5(body));
  assert.equal(f.record().commit, head);
});

test('32. a record the clone does not have, while the remote branch does not contain head: diverged, nothing written', async (t) => {
  const f = fixture(t);
  commit(f.a, { 'global/one.md': 'one\n' });
  commit(f.b, { 'global/y.md': 'y\n' });
  sh(f.b, 'git', ['push', '--force', 'origin', 'main']);
  await f.s3.put(REC, JSON.stringify({ version: 1, commit: 'c'.repeat(40), host: 'beta', time: NOW.toISOString() }));
  const before = cloneState(f.a);
  const mark = f.fake.requests.length;
  const result = await f.run();
  assert.equal(result.status, 'diverged');
  assert.deepEqual(mutating(f.fake, mark), []);
  assert.deepEqual([...f.fake.objects.keys()], [REC]);
  assert.equal(existsSync(f.stateFile), false);
  assert.deepEqual(cloneState(f.a), before);
});
