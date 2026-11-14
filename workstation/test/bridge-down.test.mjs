import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AwsError } from '../lib/aws.mjs';
import { AGENT_RE, FILE_RE, runBridgeDown, sameRemote } from '../lib/bridge-down.mjs';
import { createS3 } from '../lib/s3.mjs';
import { createFakeS3 } from './fake-s3.mjs';
import { isolateGit, makeRemoteAndClones, sh, tempDir } from './helpers.mjs';

isolateGit();

const credentials = { accessKeyId: 'EXAMPLEKEYID', secretAccessKey: 'example-signing-value', sessionToken: 'example-session-value' };
const SECRET = 'TO' + 'KEN=abcDEF1234567890abcDEF1234567890ab';
const NOW = new Date('2026-11-14T10:00:00Z');
const md5 = (body) => `"${createHash('md5').update(body).digest('hex')}"`;

const BODY = (name) => `---\nname: ${name}\n---\n\nNote ${name}.\n`;

// Every file of a directory (not .git) with its content, to compare before and after.
function tree(dir, rel = '') {
  const out = {};
  for (const name of readdirSync(join(dir, rel)).sort()) {
    if (rel === '' && name === '.git') continue;
    const p = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(dir, p));
    if (st.isDirectory()) Object.assign(out, tree(dir, p));
    else out[p] = st.isSymbolicLink() ? 'link' : readFileSync(join(dir, p), 'utf8');
  }
  return out;
}

const notesState = (dir) => ({
  head: sh(dir, 'git', ['rev-parse', 'HEAD']),
  status: sh(dir, 'git', ['status', '--porcelain']),
  files: sh(dir, 'git', ['ls-files']),
  tree: tree(dir),
});

function fixture(t, { down = true, marker = true } = {}) {
  const notes = makeRemoteAndClones(t); // the notes clone and its own remote
  const agents = makeRemoteAndClones(t); // the second repository: remote, clone, and a clone to publish with
  const fake = createFakeS3();
  const stateDir = join(tempDir(t), 'state');
  const controller = new AbortController();
  const s3 = down
    ? createS3({
      bucket: 'example-bucket', region: 'ap-northeast-1', credentials, fetchImpl: fake.fetch,
      now: () => NOW, sleep: async () => {}, signal: controller.signal,
    })
    : null;
  const config = {
    host: 'alpha', repoDir: notes.a, repoUrl: null, stateDir, claudeDir: '/unused', staleAfterSeconds: 600,
    bridge: { bucket: 'example-bucket', region: 'ap-northeast-1', up: false, down, agentsRepoDir: agents.a, agentsRepoUrl: null },
  };
  const run = (opts = {}) => runBridgeDown({ config, s3, now: NOW, signal: controller.signal, ...opts });
  const put = (key, body) => fake.objects.set(key, { body: Buffer.from(body), etag: md5(Buffer.from(body)) });
    const subjects = () => sh(agents.remote, 'git', ['log', '--format=%s', 'main']).trim().split('\n');
  const gets = () => fake.requests.filter((r) => r.method === 'GET' && r.key !== '').map((r) => r.key);
  const lists = () => fake.requests.filter((r) => r.method === 'GET' && r.key === '').length;
  const before = notesState(notes.a);
  const notesUntouched = () => assert.deepEqual(notesState(notes.a), before, 'the notes clone changed');
  // Publishes files to the second repository from its other clone, as someone else would.
  // A value is a string, { link }, { exec } (an executable file) or { gitlink } (a commit id).
  const publish = (files, message = 'chore: other change') => {
    sh(agents.b, 'git', ['fetch', '-q', 'origin']);
    sh(agents.b, 'git', ['reset', '-q', '--hard', 'origin/main']);
    const added = [];
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(agents.b, rel)), { recursive: true });
      if (typeof content !== 'object' || content.gitlink === undefined) added.push(rel);
      if (typeof content === 'string') writeFileSync(join(agents.b, rel), content);
      else if (content.link) symlinkSync(content.link, join(agents.b, rel));
      else if (content.exec !== undefined) { writeFileSync(join(agents.b, rel), content.exec); chmodSync(join(agents.b, rel), 0o755); }
      else sh(agents.b, 'git', ['update-index', '--add', '--cacheinfo', `160000,${content.gitlink},${rel}`]);
    }
    if (added.length > 0) sh(agents.b, 'git', ['add', '-f', '--', ...added]);
    sh(agents.b, 'git', ['commit', '-m', message]);
    sh(agents.b, 'git', ['push', 'origin', 'main']);
  };
  if (marker) publish({ '.agent-memory-mirror': 'agents repository\n' }, 'chore: marker');
  const base = subjects().length;
  const mirror = (rel) => join(agents.a, 'agents', rel);
  return { notes, agents, fake, s3, config, run, put, subjects, gets, lists, notesUntouched, controller, publish, base, mirror };
}

const SCAFFOLD = { '.agent-memory-mirror': 'agents repository\n', '.gitattributes': 'MEMORY.md merge=union\n', '.gitignore': '*.tmp.*\n' };


const ATTEMPT = /^Error: the agents clone is not usable: /;
const remoteHead = (f) => sh(f.agents.remote, 'git', ['rev-parse', 'main']).trim();
const remoteFiles = (f) => sh(f.agents.remote, 'git', ['ls-tree', '-r', '--name-only', 'main']).trim().split('\n');

test('1. three objects under two agents are written under agents/, one commit is pushed, status mirrored', async (t) => {
  const f = fixture(t);
  f.put('agents/alpha-bot/one.md', BODY('one'));
  f.put('agents/alpha-bot/MEMORY.md', '- [one](one.md)\n');
  f.put('agents/beta/two.md', BODY('two'));
  const result = await f.run();
  assert.equal(result.status, 'mirrored');
  assert.equal(result.written, 3);
  assert.equal(result.removed, 0);
  assert.deepEqual(result.skipped, []);
  assert.equal(readFileSync(f.mirror('alpha-bot/one.md'), 'utf8'), BODY('one'));
  assert.equal(readFileSync(f.mirror('beta/two.md'), 'utf8'), BODY('two'));
  assert.equal(statSync(f.mirror('beta/two.md')).mode & 0o777, 0o644);
  assert.deepEqual(f.subjects().slice(0, 2), ['bridge(alpha): 3 file(s)', 'chore: marker']);
  assert.equal(f.subjects().length, f.base + 1);
  assert.equal(remoteHead(f), result.commit);
  assert.equal(sh(f.agents.remote, 'git', ['log', '-1', '--format=%an <%ae>%n%b', 'main']).trim(), 'agent-memory-sync <agent-memory-sync@alpha.invalid>');
  assert.deepEqual(remoteFiles(f).filter((p) => p.startsWith('agents/')), ['agents/alpha-bot/MEMORY.md', 'agents/alpha-bot/one.md', 'agents/beta/two.md']);
  f.notesUntouched();
});

test('2. a second run with the same listing makes one list request, no get and no commit', async (t) => {
  const f = fixture(t);
  f.put('agents/a/one.md', BODY('one'));
  await f.run();
  const requests = f.fake.requests.length;
  const commits = f.subjects().length;
  const again = await f.run();
  assert.equal(again.status, 'unchanged');
  assert.equal(again.written, 0);
  assert.equal(f.fake.requests.length - requests, 1);
  assert.equal(f.fake.requests.at(-1).key, '');
  assert.equal(f.subjects().length, commits);
});

test('3. a changed ETag updates that file only; a vanished object is removed with its empty folder', async (t) => {
  const f = fixture(t);
  f.put('agents/a/keep.md', BODY('keep'));
  f.put('agents/a/change.md', BODY('change'));
  f.put('agents/b/gone.md', BODY('gone'));
  await f.run();
  const fetched = f.gets().length;
  f.put('agents/a/change.md', BODY('changed'));
  f.fake.objects.delete('agents/b/gone.md');
  const result = await f.run();
  assert.equal(result.status, 'mirrored');
  assert.equal(result.written, 1);
  assert.equal(result.removed, 1);
  assert.deepEqual(f.gets().slice(fetched), ['agents/a/change.md']);
  assert.equal(readFileSync(f.mirror('a/change.md'), 'utf8'), BODY('changed'));
  assert.equal(existsSync(f.mirror('b')), false);
  assert.equal(existsSync(join(f.agents.a, 'agents')), true);
  assert.equal(f.subjects()[0], 'bridge(alpha): 2 file(s)');
  f.notesUntouched();
});

test('3b. an emptied bucket removes every mirrored file and the removal is committed', async (t) => {
  const f = fixture(t);
  f.put('agents/a/one.md', BODY('one'));
  await f.run();
  f.fake.objects.clear();
  const result = await f.run();
  assert.equal(result.status, 'mirrored');
  assert.equal(result.removed, 1);
  assert.equal(existsSync(f.mirror('a')), false);
  assert.deepEqual(remoteFiles(f).filter((p) => p.startsWith('agents/')), []);
});

test('4. bad keys are skipped; nothing is written outside the clone or into the notes clone', async (t) => {
  const f = fixture(t);
  const sentinel = join(dirname(f.agents.a), 'sentinel');
  mkdirSync(sentinel);
  writeFileSync(join(sentinel, 'x.md'), 'untouched');
  const bad = ['agents/../evil.md', 'agents/Up/x.md', 'agents/a/b/c.md', 'agents/a/x.txt', 'agents/a/.md', 'agents//x.md', 'agents/a/',
    'agents/a/x.md\n', 'agents/a/.hidden.md', 'agents/a/%2e%2e.md', 'other/a/x.md', 'agents/a/x\u0000.md'];
  for (const key of bad) f.put(key, 'x');
  f.put('agents/a/good.md', BODY('good'));
  const result = await f.run();
  // 'other/a/x.md' is not under the listed prefix; every other key is reported.
  assert.deepEqual(result.skipped.map((s) => s.reason), Array(bad.length - 1).fill('bad-key'));
  assert.equal(result.written, 1);
  assert.deepEqual(tree(f.agents.a), { ...SCAFFOLD, 'agents/a/good.md': BODY('good') });
  assert.deepEqual(tree(sentinel), { 'x.md': 'untouched' });
  assert.equal(existsSync(join(dirname(f.agents.a), 'evil.md')), false);
  f.notesUntouched();
});

test('5. a symbolic link where an agent folder belongs throws and nothing is written through it', async (t) => {
  const f = fixture(t);
  const outside = join(tempDir(t), 'outside');
  mkdirSync(outside);
  f.publish({ 'agents/a': { link: outside } }, 'chore: link');
  f.put('agents/a/x.md', BODY('x'));
  const before = f.subjects().length;
  await assert.rejects(() => f.run(), (err) => err instanceof Error && !/outside|x\.md/.test(err.message));
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(lstatSync(f.mirror('a')).isSymbolicLink(), true);
  assert.equal(f.subjects().length, before);
  f.notesUntouched();
});

test('5b. a file where an agent folder belongs throws', async (t) => {
  const f = fixture(t);
  f.publish({ 'agents/a': 'a file' }, 'chore: file');
  f.put('agents/a/x.md', BODY('x'));
  await assert.rejects(() => f.run(), /agent folder/);
});

test('5c. a symbolic link at the destination file is replaced, never followed', async (t) => {
  const f = fixture(t);
  const outside = join(tempDir(t), 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'target.txt'), 'precious');
  f.publish({ 'agents/a/x.md': { link: join(outside, 'target.txt') } }, 'chore: planted link');
  f.put('agents/a/x.md', BODY('x'));
  const result = await f.run();
  assert.equal(result.status, 'mirrored');
  assert.equal(lstatSync(f.mirror('a/x.md')).isSymbolicLink(), false);
  assert.equal(readFileSync(f.mirror('a/x.md'), 'utf8'), BODY('x'));
  assert.equal(readFileSync(join(outside, 'target.txt'), 'utf8'), 'precious');
});

test('5d. a folder or a link the remote planted inside an agent folder is removed, not followed', async (t) => {
  const f = fixture(t);
  const outside = join(tempDir(t), 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'precious');
  f.publish({ 'agents/a/sub/deep.md': 'x', 'agents/a/link.md': { link: outside }, 'agents/a/y.md': 'stray' }, 'chore: planted');
  f.put('agents/a/y.md', BODY('y'));
  const result = await f.run();
  assert.equal(result.status, 'mirrored');
  assert.deepEqual(tree(f.agents.a), { ...SCAFFOLD, 'agents/a/y.md': BODY('y') });
  assert.deepEqual(readdirSync(outside), ['keep.txt']);
});

test('5e. a link in place of the agents folder itself throws', async (t) => {
  const f = fixture(t);
  const outside = join(tempDir(t), 'outside');
  mkdirSync(join(outside, 'a'), { recursive: true });
  writeFileSync(join(outside, 'a/x.md'), BODY('x'));
  f.publish({ agents: { link: outside } }, 'chore: link');
  f.put('agents/a/x.md', BODY('x'));
  await assert.rejects(() => f.run(), /^Error: the agents clone is not usable: /);
  assert.deepEqual(readdirSync(join(outside, 'a')), ['x.md']);
});

test('6. local edits and untracked files are discarded; the owner\'s own files and folders stay untouched and committed', async (t) => {
  const f = fixture(t);
  f.publish({
    'README.md': 'about the mirror\n', 'docs/guide.md': 'the guide\n', 'docs/img/x.png': '\u0089PNG', 'global/y.md': 'owner folder named like an agent\n',
  }, 'docs: owner files');
  f.put('agents/a/one.md', BODY('one'));
  const first = await f.run();
  assert.equal(first.removed, 0);
  assert.equal(first.status, 'mirrored');
  writeFileSync(f.mirror('a/one.md'), 'edited locally');
  writeFileSync(f.mirror('a/untracked.md'), 'new');
  writeFileSync(join(f.agents.a, 'stray.txt'), 'new');
  writeFileSync(join(f.agents.a, 'README.md'), 'edited too');
  const result = await f.run();
  assert.equal(result.status, 'unchanged'); // what was discarded is not a change to the mirror
  assert.equal(result.written, 0);
  assert.equal(result.removed, 0);
  assert.equal(readFileSync(f.mirror('a/one.md'), 'utf8'), BODY('one'));
  assert.equal(existsSync(f.mirror('a/untracked.md')), false);
  assert.equal(existsSync(join(f.agents.a, 'stray.txt')), false);
  assert.equal(readFileSync(join(f.agents.a, 'README.md'), 'utf8'), 'about the mirror\n');
  assert.equal(readFileSync(join(f.agents.a, 'docs/guide.md'), 'utf8'), 'the guide\n');
  assert.equal(readFileSync(join(f.agents.a, 'global/y.md'), 'utf8'), 'owner folder named like an agent\n');
  assert.deepEqual(remoteFiles(f).filter((p) => !p.startsWith('.')).sort(),
    ['README.md', 'agents/a/one.md', 'docs/guide.md', 'docs/img/x.png', 'global/y.md']);
});

test('7. a flagged object is skipped, is not in the clone, and an earlier copy is removed', async (t) => {
  const f = fixture(t);
  f.put('agents/a/one.md', BODY('one'));
  await f.run();
  f.put('agents/a/one.md', `${BODY('one')}\n${SECRET}\n`);
  f.put('agents/a/two.md', BODY('two'));
  const result = await f.run();
  assert.deepEqual(result.skipped, [{ key: 'agents/a/one.md', reason: 'flagged' }]);
  assert.equal(result.removed, 1);
  assert.equal(existsSync(f.mirror('a/one.md')), false);
  assert.equal(remoteFiles(f).includes('agents/a/one.md'), false);
  assert.equal(JSON.stringify(result).includes('abcDEF'), false);
});

test('8. an object over 200,000 bytes is skipped; 5,001 valid keys throw before any write', async (t) => {
  const f = fixture(t);
  f.put('agents/a/big.md', 'x'.repeat(200_001));
  f.put('agents/a/edge.md', 'y'.repeat(200_000));
  const result = await f.run();
  assert.deepEqual(result.skipped, [{ key: 'agents/a/big.md', reason: 'too-large' }]);
  assert.equal(existsSync(f.mirror('a/big.md')), false);
  assert.equal(statSync(f.mirror('a/edge.md')).size, 200_000);
  assert.equal(f.gets().includes('agents/a/big.md'), false);

  const g = fixture(t);
  for (let i = 0; i < 5001; i += 1) g.put(`agents/a/n${i}.md`, 'x');
  await assert.rejects(() => g.run(), /too many/);
  assert.deepEqual(tree(g.agents.a), SCAFFOLD);
  assert.equal(g.gets().length, 0);
});

test('8b. an object larger than its listed size is skipped as too-large', async (t) => {
  const f = fixture(t);
  f.put('agents/a/liar.md', 'small');
  f.put('agents/a/fine.md', BODY('fine'));
  f.fake.onRequest(({ method, key }) => {
    if (method === 'GET' && key === 'agents/a/liar.md') f.put('agents/a/liar.md', 'z'.repeat(300_000));
  });
  const result = await f.run();
  assert.deepEqual(result.skipped, [{ key: 'agents/a/liar.md', reason: 'too-large' }]);
  assert.equal(result.written, 1);
  assert.equal(existsSync(f.mirror('a/liar.md')), false);
});

test('8c. a hostile key is reported cut and without control characters or lone surrogates', async (t) => {
  const f = fixture(t);
  const long = `agents/a/${'k'.repeat(300)}.md`;
  const control = 'agents/a/ev\u001b[31mil\n\u202e.md';
  f.put(long, 'x');
  f.put(control, 'x');
  const result = await f.run();
  assert.equal(result.skipped.length, 2);
  for (const { key, reason } of result.skipped) {
    assert.equal(reason, 'bad-key');
    assert.ok([...key].length <= 200);
    assert.doesNotMatch(key, /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u);
  }
  assert.ok(result.skipped.some((s) => s.key === 'agents/a/ev?[31mil??.md'));
});

test('8d. more than 200 skipped keys are reported cut, with the number left out', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 230; i += 1) f.put(`agents/a/bad${i}.txt`, 'x');
  const result = await f.run();
  assert.equal(result.skipped.length, 200);
  assert.equal(result.skippedMore, 30);
});

test('9. a failure of the S3 client passes through unchanged', async (t) => {
  const f = fixture(t);
  f.put('agents/a/one.md', BODY('one'));
  f.fake.failNext(3, 503);
  await assert.rejects(() => f.run(), (err) => err instanceof AwsError && err.operation === 'list' && err.status === 503);
  f.notesUntouched();
});

test('9b. another failure carries no key and no Git output', async (t) => {
  const f = fixture(t);
  sh(f.agents.a, 'git', ['remote', 'set-url', 'origin', join(dirname(f.agents.a), 'no-such-secret-name.git')]);
  await assert.rejects(() => f.run(), (err) => err instanceof Error && !(err instanceof AwsError) && !/secret-name|\/tmp/.test(err.message));
});

test('10. an agents clone whose origin is the notes origin is refused (URL layer), with nothing fetched or written', async (t) => {
  for (const spell of [(u) => u, (u) => `${u}/`, (u) => `${u}.git`, (u) => `file://${u}`, (u) => `file://${u}.git/`]) {
    const f = fixture(t);
    const notesUrl = sh(f.notes.a, 'git', ['remote', 'get-url', 'origin']).trim();
    // The notes repository carries a marker too, so that only the URL comparison can refuse.
    sh(f.notes.b, 'git', ['pull', '-q', 'origin', 'main']);
    writeFileSync(join(f.notes.b, '.agent-memory-mirror'), 'x\n');
    sh(f.notes.b, 'git', ['add', '-A']);
    sh(f.notes.b, 'git', ['commit', '-m', 'chore: marker']);
    sh(f.notes.b, 'git', ['push', 'origin', 'main']);
    const notesHead = sh(f.notes.remote, 'git', ['rev-parse', 'main']).trim();
    sh(f.agents.a, 'git', ['remote', 'set-url', 'origin', spell(notesUrl.replace(/\.git$/, ''))]);
    f.put('agents/a/one.md', BODY('one'));
    await assert.rejects(() => f.run(), (err) => ATTEMPT.test(String(err)) && !err.message.includes(notesUrl));
    assert.equal(f.fake.requests.length, 0);
    assert.equal(existsSync(join(f.agents.a, '.git/FETCH_HEAD')), false);
    assert.equal(existsSync(f.mirror('a')), false);
    assert.equal(sh(f.notes.remote, 'git', ['rev-parse', 'main']).trim(), notesHead);
    f.notesUntouched();
  }
});

test('10a. the same repository under different spellings is recognised', () => {
  const same = [
    ['https://example.com/o/r.git', 'git@example.com:o/r.git'],
    ['https://example.com/o/r.git', 'ssh://git@EXAMPLE.com/o/r'],
    ['https://user:secret-value@example.com/o/r/', 'git://example.com/o/r'],
    ['ssh://git@example.com:22/o/r.git', 'example.com:o/r'],
    ['/srv/git/r.git', 'file:///srv/git/r'],
    ['/srv/git/r/', '/srv/git/r.git'],
  ];
  for (const [a, b] of same) assert.equal(sameRemote(a, b), true, `${a} ${b}`);
  const different = [
    ['https://example.com/o/r', 'https://example.com/o/r2'],
    ['https://example.com/o/r', 'https://example.com/o/R'],
    ['https://example.com/o/r', 'https://example.org/o/r'],
    ['/srv/git/r.git', '/srv/git/s.git'],
  ];
  for (const [a, b] of different) assert.equal(sameRemote(a, b), false, `${a} ${b}`);
});

test('10b. a notes clone without a readable origin is refused', async (t) => {
  const f = fixture(t);
  sh(f.notes.a, 'git', ['remote', 'remove', 'origin']);
  const notesBefore = notesState(f.notes.a);
  await assert.rejects(() => f.run(), /^Error: the agents clone is not usable: the notes clone has no readable remote$/);
  assert.equal(f.fake.requests.length, 0);
  assert.equal(existsSync(join(f.agents.a, '.git/FETCH_HEAD')), false);
  assert.deepEqual(notesState(f.notes.a), notesBefore);
});

test('10c. a folder that is not the top level of a work tree, or not on main, is refused', async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.agents.a, 'sub'));
  f.config.bridge.agentsRepoDir = join(f.agents.a, 'sub');
  await assert.rejects(() => f.run(), ATTEMPT);
  f.config.bridge.agentsRepoDir = join(dirname(f.agents.a), 'missing');
  await assert.rejects(() => f.run(), ATTEMPT);
  f.config.bridge.agentsRepoDir = f.agents.a;
  sh(f.agents.a, 'git', ['checkout', '-q', '-b', 'side']);
  await assert.rejects(() => f.run(), ATTEMPT);
  assert.equal(f.fake.requests.length, 0);
});

test('10d. a remote without the marker file is refused before anything in the clone changes (marker layer)', async (t) => {
  const f = fixture(t, { marker: false });
  f.put('agents/a/one.md', BODY('one'));
  writeFileSync(join(f.agents.a, '.gitignore'), 'local edit');
  writeFileSync(join(f.agents.a, 'untracked.txt'), 'local');
  await assert.rejects(() => f.run(), /^Error: the agents clone is not usable: its remote has no \.agent-memory-mirror marker$/);
  assert.equal(f.fake.requests.length, 0);
  assert.equal(readFileSync(join(f.agents.a, '.gitignore'), 'utf8'), 'local edit');
  assert.equal(readFileSync(join(f.agents.a, 'untracked.txt'), 'utf8'), 'local');
  assert.equal(existsSync(f.mirror('a')), false);
  f.notesUntouched();
});

test('10e. a remote that is the notes repository by another spelling is refused by the marker alone', async (t) => {
  const f = fixture(t, { marker: false });
  const other = tempDir(t);
  sh(other, 'git', ['clone', '-q', '-b', 'main', f.notes.remote, join(other, 'c')]);
  // Same repository, but the URL comparison cannot know: a different path to the same content.
  sh(f.agents.a, 'git', ['remote', 'set-url', 'origin', join(other, 'alias.git')]);
  sh(other, 'cp', ['-r', f.notes.remote, join(other, 'alias.git')]);
  const notesHead = sh(f.notes.remote, 'git', ['rev-parse', 'main']).trim();
  f.put('agents/a/one.md', BODY('one'));
  await assert.rejects(() => f.run(), /marker/);
  assert.equal(sh(f.notes.remote, 'git', ['rev-parse', 'main']).trim(), notesHead);
  f.notesUntouched();
});

test('10f. the marker missing in pull-only mode is refused and a local edit is still there', async (t) => {
  const f = fixture(t, { down: false, marker: false });
  writeFileSync(join(f.agents.a, '.gitignore'), 'local edit');
  await assert.rejects(() => f.run(), /marker/);
  assert.equal(readFileSync(join(f.agents.a, '.gitignore'), 'utf8'), 'local edit');
});

test('C1a. an agents folder that is a link into the notes clone is refused and neither clone changes', async (t) => {
  const f = fixture(t);
  const inner = join(f.notes.a, 'inner');
  sh(dirname(f.notes.a), 'git', ['clone', '-q', '-b', 'main', f.agents.remote, inner]);
  const link = join(tempDir(t), 'link');
  symlinkSync(inner, link);
  f.config.bridge.agentsRepoDir = link;
  f.put('agents/a/one.md', BODY('one'));
  const notesBefore = notesState(f.notes.a);
  await assert.rejects(() => f.run(), /^Error: the agents clone is not usable: it overlaps the notes clone$/);
  assert.deepEqual(notesState(f.notes.a), notesBefore);
  assert.equal(existsSync(join(inner, '.git/FETCH_HEAD')), false);
  assert.equal(f.fake.requests.length, 0);
});

test('C1b. a notes clone that is a link to a folder inside the agents clone is refused and survives', async (t) => {
  const f = fixture(t);
  const inner = join(f.agents.a, 'agents');
  mkdirSync(inner);
  sh(inner, 'git', ['clone', '-q', '-b', 'main', f.notes.remote, join(inner, 'notes')]);
  const link = join(tempDir(t), 'link');
  symlinkSync(join(inner, 'notes'), link);
  f.config.repoDir = link;
  f.put('agents/a/one.md', BODY('one'));
  const notesBefore = notesState(join(inner, 'notes'));
  await assert.rejects(() => f.run(), /^Error: the agents clone is not usable: it overlaps the notes clone$/);
  assert.deepEqual(notesState(join(inner, 'notes')), notesBefore);
  assert.equal(existsSync(join(f.agents.a, '.git/FETCH_HEAD')), false);
});

test('C1c. the same folder reached by a link, and a notes clone that cannot be resolved, are refused', async (t) => {
  const f = fixture(t);
  const link = join(tempDir(t), 'link');
  symlinkSync(f.notes.a, link);
  f.config.bridge.agentsRepoDir = link;
  await assert.rejects(() => f.run(), /overlaps the notes clone/);
  f.config.bridge.agentsRepoDir = f.agents.a;
  f.config.repoDir = join(dirname(f.notes.a), 'missing');
  await assert.rejects(() => f.run(), /^Error: the agents clone is not usable: the notes clone cannot be resolved$/);
  assert.equal(existsSync(join(f.agents.a, '.git/FETCH_HEAD')), false);
});

test('11. down false: no S3 request; a commit by another clone arrives as pulled; a local edit is discarded', async (t) => {
  const f = fixture(t, { down: false });
  f.publish({ 'agents/a/one.md': BODY('one') }, 'chore: from elsewhere');
  writeFileSync(join(f.agents.a, '.gitignore'), 'edited');
  const first = await f.run();
  assert.equal(first.status, 'pulled');
  assert.equal(first.written, 0);
  assert.equal(readFileSync(f.mirror('a/one.md'), 'utf8'), BODY('one'));
  assert.equal(readFileSync(join(f.agents.a, '.gitignore'), 'utf8'), '*.tmp.*\n');
  const second = await f.run();
  assert.equal(second.status, 'unchanged');
  assert.equal(f.fake.requests.length, 0);
  f.notesUntouched();
});

test('12. a refused push gives push-failed; the next run, with the hook gone, mirrors', async (t) => {
  const f = fixture(t);
  f.put('agents/a/one.md', BODY('one'));
  await f.run();
  f.put('agents/a/two.md', BODY('two'));
  const hook = join(f.agents.remote, 'hooks/pre-receive');
  writeFileSync(hook, '#!/bin/sh\nexit 1\n');
  chmodSync(hook, 0o755);
  const head = remoteHead(f);
  const refused = await f.run();
  assert.equal(refused.status, 'push-failed');
  assert.equal(remoteHead(f), head);
  assert.equal(f.subjects().length, f.base + 1);
  sh(f.agents.remote, 'rm', ['-f', hook]);
  const ok = await f.run();
  assert.equal(ok.status, 'mirrored');
  assert.equal(ok.written, 1);
  assert.equal(f.subjects()[0], 'bridge(alpha): 1 file(s)');
  assert.equal(f.subjects().length, f.base + 2);
  assert.equal(remoteHead(f), ok.commit);
  f.notesUntouched();
});

test('14. a stopped run throws the time-limit error, before and during the downloads', async (t) => {
  const f = fixture(t);
  f.put('agents/a/one.md', BODY('one'));
  f.put('agents/a/two.md', BODY('two'));
  f.controller.abort();
  await assert.rejects(() => f.run(), (err) => err instanceof AwsError && err.operation === 'bridge-down' && err.code === 'TimeLimit');
  assert.equal(f.fake.requests.length, 0);

  const g = fixture(t);
  for (let i = 0; i < 20; i += 1) g.put(`agents/a/n${i}.md`, BODY(`n${i}`));
  g.fake.onRequest(({ method, key }) => { if (method === 'GET' && key !== '') g.controller.abort(); });
  await assert.rejects(() => g.run(), (err) => err instanceof AwsError && err.code === 'TimeLimit');
  assert.ok(g.gets().length < 20);
  assert.equal(g.subjects().length, g.base);
  g.notesUntouched();
});

test('15. never more than eight downloads at once', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 30; i += 1) f.put(`agents/a/n${i}.md`, BODY(`n${i}`));
  let inFlight = 0;
  let peak = 0;
  const wrap = f.fake.fetch;
  const s3 = createS3({
    bucket: 'example-bucket', region: 'ap-northeast-1', credentials, now: () => NOW, sleep: async () => {},
    fetchImpl: async (url, init) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        return await wrap(url, init);
      } finally { inFlight -= 1; }
    },
  });
  const result = await f.run({ s3 });
  assert.equal(result.written, 30);
  assert.ok(peak <= 8 && peak > 1, `peak ${peak}`);
});

test('16. the rules are the API rules', () => {
  assert.equal(AGENT_RE.source, '^[a-z0-9][a-z0-9-]{0,39}$');
  assert.equal(FILE_RE.source, '^[A-Za-z0-9][A-Za-z0-9._-]{0,196}\\.md$');
});

test('I3a. a .gitignore of the remote cannot keep mirrored files out of the commit', async (t) => {
  const f = fixture(t);
  f.publish({ '.gitignore': '*.md\nagents/\n' }, 'chore: ignore everything');
  f.put('agents/a/one.md', BODY('one'));
  const result = await f.run();
  assert.equal(result.status, 'mirrored');
  assert.ok(remoteFiles(f).includes('agents/a/one.md'));
});

test('I4a. a file or a folder the remote keeps under agents/ that is not an agent folder is removed, and the removal is committed', async (t) => {
  const f = fixture(t);
  f.publish({ 'docs/guide.md': 'guide\n', 'global/y.md': 'owner folder\n', 'agents/README.md': 'extra', 'agents/Up/x.md': 'extra' }, 'chore: planted');
  f.put('agents/a/x.md', BODY('x'));
  const result = await f.run();
  assert.equal(result.status, 'mirrored');
  assert.deepEqual(remoteFiles(f).filter((p) => !p.startsWith('.')).sort(), ['agents/a/x.md', 'docs/guide.md', 'global/y.md']);
  assert.deepEqual(tree(f.agents.a), { ...SCAFFOLD, 'agents/a/x.md': BODY('x'), 'docs/guide.md': 'guide\n', 'global/y.md': 'owner folder\n' });
  assert.equal((await f.run()).status, 'unchanged');
});

test('I4b. a gitlink at an agent path is replaced by the real folder with the bucket\'s files', async (t) => {
  const f = fixture(t);
  f.publish({ 'agents/a': { gitlink: 'a'.repeat(40) } }, 'chore: planted');
  f.put('agents/a/x.md', BODY('x'));
  const result = await f.run();
  assert.equal(result.status, 'mirrored');
  assert.equal(sh(f.agents.remote, 'git', ['ls-tree', 'main', 'agents/a/x.md']).startsWith('100644 blob'), true);
  assert.equal(sh(f.agents.remote, 'git', ['ls-tree', 'main', 'agents/a']).startsWith('040000 tree'), true);
  assert.equal(readFileSync(f.mirror('a/x.md'), 'utf8'), BODY('x'));
});

test('I4c. an ignored untracked file under agents/ is removed and the run completes', async (t) => {
  const f = fixture(t);
  f.publish({ '.gitignore': '.DS_Store\n' }, 'chore: ignore');
  f.put('agents/a/x.md', BODY('x'));
  await f.run();
  writeFileSync(f.mirror('.DS_Store'), 'junk');
  writeFileSync(f.mirror('a/.DS_Store'), 'junk');
  const result = await f.run();
  assert.equal(result.status, 'unchanged');
  assert.equal(existsSync(f.mirror('.DS_Store')), false);
  assert.equal(existsSync(f.mirror('a/.DS_Store')), false);
});

test('I4d. a link, a gitlink or a file in place of the agents folder itself still throws', async (t) => {
  const f = fixture(t);
  f.publish({ agents: { gitlink: 'a'.repeat(40) } }, 'chore: planted');
  f.put('agents/a/x.md', BODY('x'));
  const head = remoteHead(f);
  await assert.rejects(() => f.run(), /^Error: the agents clone is not usable: /);
  assert.equal(remoteHead(f), head);
});

test('I4e. a marker that is a symbolic link is refused like a missing one', async (t) => {
  const f = fixture(t, { marker: false });
  f.publish({ '.agent-memory-mirror': { link: 'README.md' } }, 'chore: link marker');
  f.put('agents/a/x.md', BODY('x'));
  writeFileSync(join(f.agents.a, '.gitignore'), 'local edit');
  await assert.rejects(() => f.run(), /marker/);
  assert.equal(readFileSync(join(f.agents.a, '.gitignore'), 'utf8'), 'local edit');
});

test('I3c. a hand edit of a mirrored file on the remote is restored to the bucket\'s bytes', async (t) => {
  const f = fixture(t);
  f.put('agents/a/x.md', BODY('x'));
  await f.run();
  f.publish({ 'agents/a/x.md': 'hand edit\n' }, 'chore: hand edit');
  const result = await f.run();
  assert.equal(result.status, 'mirrored');
  assert.equal(result.written, 1);
  assert.equal(readFileSync(f.mirror('a/x.md'), 'utf8'), BODY('x'));
  assert.equal(sh(f.agents.remote, 'git', ['show', 'main:agents/a/x.md']), BODY('x'));
});

test('I3d. an executable bit planted on a mirrored file is repaired', async (t) => {
  const f = fixture(t);
  f.put('agents/a/x.md', BODY('x'));
  await f.run();
  f.publish({ 'agents/a/x.md': { exec: BODY('x') } }, 'chore: chmod');
  const result = await f.run();
  assert.equal(result.status, 'mirrored');
  assert.equal(sh(f.agents.remote, 'git', ['ls-tree', 'main', 'agents/a/x.md']).startsWith('100644'), true);
});

test('I3e. an agent folder replaced by a link on the remote throws, also when nothing needs a write', async (t) => {
  const f = fixture(t);
  f.put('agents/a/x.md', BODY('x'));
  await f.run();
  const outside = join(tempDir(t), 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'x.md'), BODY('x'));
  sh(f.agents.b, 'git', ['fetch', '-q', 'origin']);
  sh(f.agents.b, 'git', ['reset', '-q', '--hard', 'origin/main']);
  sh(f.agents.b, 'git', ['rm', '-r', '-q', 'agents/a']);
  mkdirSync(join(f.agents.b, 'agents'), { recursive: true });
  symlinkSync(outside, join(f.agents.b, 'agents/a'));
  sh(f.agents.b, 'git', ['add', '-A']);
  sh(f.agents.b, 'git', ['commit', '-m', 'chore: replace folder by link']);
  sh(f.agents.b, 'git', ['push', 'origin', 'main']);
  const head = remoteHead(f);
  await assert.rejects(() => f.run(), /link or a file/);
  assert.equal(remoteHead(f), head);
  assert.deepEqual(readdirSync(outside), ['x.md']);
});

test('I3f. an object whose ETag is not an MD5 is fetched on every run and makes no commit when unchanged', async (t) => {
  const f = fixture(t);
  f.fake.objects.set('agents/a/x.md', { body: Buffer.from(BODY('x')), etag: '"deadbeef-2"' });
  const first = await f.run();
  assert.equal(first.status, 'mirrored');
  const commits = f.subjects().length;
  const gets = f.gets().length;
  const second = await f.run();
  assert.equal(second.status, 'unchanged');
  assert.equal(second.written, 0);
  assert.equal(f.gets().length, gets + 1);
  assert.equal(f.subjects().length, commits);
});

// ---- W1: a lock left behind by a killed run ----

const LOCKS = ['index.lock', 'HEAD.lock', 'refs/heads/main.lock', 'refs/remotes/origin/main.lock'];
function lockFile(f, name, ageMs) {
  const file = join(f.agents.a, '.git', name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
  const at = new Date(Date.now() - ageMs);
  utimesSync(file, at, at);
  return file;
}

for (const lock of LOCKS) {
  test(`W1: a stale ${lock} in the agents clone is removed and the run succeeds, in mirror mode`, async (t) => {
    const f = fixture(t);
    f.put('agents/a/one.md', BODY('one'));
    const file = lockFile(f, lock, 3_600_000);
    assert.equal((await f.run()).status, 'mirrored');
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(f.mirror('a/one.md'), 'utf8'), BODY('one'));
  });

  test(`W1: a stale ${lock} in the agents clone is removed and the run succeeds, in pull-only mode`, async (t) => {
    const f = fixture(t, { down: false });
    f.publish({ 'agents/a/one.md': BODY('one') }, 'feat: other note');
    const file = lockFile(f, lock, 3_600_000);
    assert.equal((await f.run()).status, 'pulled');
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(f.mirror('a/one.md'), 'utf8'), BODY('one'));
  });
}

test('W1: a fresh lock is left alone and the run fails with its fixed text', async (t) => {
  const f = fixture(t, { down: false });
  f.publish({ 'agents/a/one.md': BODY('one') }, 'feat: other note');
  const file = lockFile(f, 'index.lock', 5_000);
  await assert.rejects(() => f.run(), /^Error: bridge down failed while trying to update$/);
  assert.equal(existsSync(file), true);
  const fresh = lockFile(f, 'refs/remotes/origin/main.lock', 5_000);
  await assert.rejects(() => f.run(), /^Error: (fetching the agents repository failed|bridge down failed while trying to update)$/);
  assert.equal(existsSync(fresh), true);
});

test('W1: the notes clone is not looked at for locks', async (t) => {
  const f = fixture(t, { down: false });
  const file = join(f.notes.a, '.git', 'index.lock');
  writeFileSync(file, '');
  const at = new Date(Date.now() - 3_600_000);
  utimesSync(file, at, at);
  await f.run();
  assert.equal(existsSync(file), true, 'the sync engine owns the notes clone');
});
