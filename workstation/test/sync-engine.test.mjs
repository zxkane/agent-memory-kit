import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync,
  rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { git, TIMEOUT_CODE } from '../lib/git.mjs';
import { buildSessionContext } from '../lib/context.mjs';
import { bindProject } from '../lib/identity.mjs';
import { conflictName, readStatus, runSync, writeStatus } from '../lib/sync-engine.mjs';
import { isolateGit, makeRemoteAndClones, sh, tempDir } from './helpers.mjs';

isolateGit();

const SECRET = 'TO' + 'KEN=abcDEF1234567890abcDEF1234567890ab';

const cfg = (repoDir, host, stateDir) => ({ host, repoDir, repoUrl: null, stateDir, claudeDir: '/unused', staleAfterSeconds: 600 });
const pick = (obj, ...keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));
const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const append = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  appendFileSync(join(dir, rel), text);
};

// Two clones of a fresh remote, each with its own state directory.
function fixture(t) {
  const { remote, a, b } = makeRemoteAndClones(t);
  const tmp = tempDir(t);
  const stateA = join(tmp, 'state-a');
  const stateB = join(tmp, 'state-b');
  return {
    remote, a, b, tmp, stateA, stateB,
    syncA: (opts) => runSync(cfg(a, 'alpha', stateA), opts),
    syncB: (opts) => runSync(cfg(b, 'beta', stateB), opts),
  };
}

// The note exists on both clones and on the remote.
function sharedNote(f, rel, text) {
  write(f.a, rel, text);
  assert.equal(f.syncA().ok, true);
  assert.equal(f.syncB().ok, true);
  assert.equal(read(f.b, rel), text);
}

const execGitBuffer = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

const headIsRemote = (dir) =>
  sh(dir, 'git', ['rev-parse', 'HEAD']) === sh(dir, 'git', ['rev-parse', 'origin/main']);

test('git returns stdout and throws on failure unless allowFail', (t) => {
  const { a } = makeRemoteAndClones(t);
  assert.equal(git(a, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'main');
  assert.throws(() => git(a, ['rev-parse', '--verify', 'no-such-ref']));
  const r = git(a, ['rev-parse', '--verify', 'no-such-ref'], { allowFail: true });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /fatal/);
});

test('conflictName adds the host and counts up past taken names', () => {
  assert.equal(conflictName('projects/p/note.md', 'alpha', () => false), 'projects/p/note.conflict-alpha.md');
  const taken = new Set(['projects/p/note.conflict-alpha.md', 'projects/p/note.conflict-alpha-2.md']);
  assert.equal(conflictName('projects/p/note.md', 'alpha', (p) => taken.has(p)), 'projects/p/note.conflict-alpha-3.md');
  assert.equal(conflictName('README', 'beta', () => false), 'README.conflict-beta');
});

test('commits and pushes a new note', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/note.md', 'hello');
  const r = f.syncA();
  assert.deepEqual(pick(r, 'ok', 'committed', 'pushed', 'error'), { ok: true, committed: 1, pushed: true, error: null });
  assert.match(sh(f.a, 'git', ['log', '-1', '--format=%an <%ae> %cn <%ce> %s']),
    /^agent-memory-sync <agent-memory-sync@alpha\.invalid> agent-memory-sync <agent-memory-sync@alpha\.invalid> sync\(alpha\): 1 file\(s\)/);
  assert.equal(sh(f.remote, 'git', ['show', 'main:projects/p/note.md']), 'hello');
});

test('committed counts additions, modifications and deletions', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/one.md', '1');
  write(f.a, 'projects/p/two.md', '2');
  assert.equal(f.syncA().committed, 2);
  write(f.a, 'projects/p/one.md', 'changed');
  rmSync(join(f.a, 'projects/p/two.md'));
  write(f.a, 'projects/p/three.md', '3');
  const r = f.syncA();
  assert.equal(r.committed, 3);
  assert.match(sh(f.a, 'git', ['log', '-1', '--format=%s']), /^sync\(alpha\): 3 file\(s\)/);
});

test('a single-line message replaces the working-tree commit subject; any other value is ignored', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/one.md', '1');
  assert.equal(f.syncA({ message: 'consolidate(alpha): organize projects/p' }).ok, true);
  assert.equal(sh(f.a, 'git', ['log', '-1', '--format=%s']).trim(), 'consolidate(alpha): organize projects/p (1 file(s))');
  assert.equal(sh(f.remote, 'git', ['log', '-1', '--format=%s', 'main']).trim(), 'consolidate(alpha): organize projects/p (1 file(s))');
  for (const message of ['two\nlines', '', 42]) {
    write(f.a, 'projects/p/one.md', `changed ${JSON.stringify(message)}`);
    assert.equal(f.syncA({ message }).ok, true);
    assert.equal(sh(f.a, 'git', ['log', '-1', '--format=%s']).trim(), 'sync(alpha): 1 file(s)');
  }
  write(f.a, 'projects/p/one.md', 'again');
  f.syncA();
  assert.equal(sh(f.a, 'git', ['log', '-1', '--format=%s']).trim(), 'sync(alpha): 1 file(s)');
});

test('a second clone receives the note', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/note.md', 'hello');
  f.syncA();
  const r = f.syncB();
  assert.equal(r.ok, true);
  assert.equal(read(f.b, 'projects/p/note.md'), 'hello');
});

test('does nothing and stays ok when there is no change', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/note.md', 'hello');
  f.syncA();
  const before = sh(f.a, 'git', ['rev-parse', 'HEAD']);
  const r = f.syncA();
  assert.deepEqual(pick(r, 'ok', 'committed', 'merged', 'pushed', 'error'), { ok: true, committed: 0, merged: false, pushed: false, error: null });
  assert.equal(sh(f.a, 'git', ['rev-parse', 'HEAD']), before);
});

test('MEMORY.md changed on both sides merges by union', (t) => {
  const f = fixture(t);
  sharedNote(f, 'projects/p/MEMORY.md', '- [Base](base.md) — shared\n');
  append(f.a, 'projects/p/MEMORY.md', '- [A](a.md) — from alpha\n');
  append(f.b, 'projects/p/MEMORY.md', '- [B](b.md) — from beta\n');
  f.syncA();
  const r = f.syncB();
  assert.equal(r.ok, true);
  assert.equal(r.merged, true);
  assert.deepEqual(r.conflicts, []);
  const text = read(f.b, 'projects/p/MEMORY.md');
  assert.match(text, /from alpha/);
  assert.match(text, /from beta/);
  assert.equal(headIsRemote(f.b), true);
  assert.match(sh(f.b, 'git', ['log', '-1', '--format=%an %s']), /^agent-memory-sync sync\(beta\): merge origin\/main/);
});

test('the same note changed on both sides keeps both versions', (t) => {
  const f = fixture(t);
  sharedNote(f, 'projects/p/中文 Note.md', 'alpha version');
  write(f.a, 'projects/p/中文 Note.md', 'alpha edit');
  write(f.b, 'projects/p/中文 Note.md', 'beta edit');
  f.syncA();
  const r = f.syncB();
  assert.equal(r.ok, true);
  assert.equal(r.merged, true);
  assert.deepEqual(r.conflicts, ['projects/p/中文 Note.md']);
  assert.equal(read(f.b, 'projects/p/中文 Note.md'), 'alpha edit');
  assert.equal(read(f.b, 'projects/p/中文 Note.conflict-beta.md'), 'beta edit');
  assert.equal(sh(f.b, 'git', ['status', '--porcelain']), '');
  assert.equal(headIsRemote(f.b), true);
  assert.equal(f.syncA().ok, true);
  assert.equal(read(f.a, 'projects/p/中文 Note.conflict-beta.md'), 'beta edit');
});

test('a second conflict on the same note takes the next free name', (t) => {
  const f = fixture(t);
  sharedNote(f, 'projects/p/note.md', 'v0');
  for (const round of [1, 2]) {
    write(f.a, 'projects/p/note.md', `alpha ${round}`);
    write(f.b, 'projects/p/note.md', `beta ${round}`);
    f.syncA();
    assert.equal(f.syncB().ok, true);
    assert.equal(f.syncA().ok, true);
  }
  assert.equal(read(f.b, 'projects/p/note.conflict-beta.md'), 'beta 1');
  assert.equal(read(f.b, 'projects/p/note.conflict-beta-2.md'), 'beta 2');
  assert.equal(read(f.b, 'projects/p/note.md'), 'alpha 2');
});

test('a note deleted remotely and edited locally survives', (t) => {
  const f = fixture(t);
  sharedNote(f, 'projects/p/note.md', 'original');
  rmSync(join(f.a, 'projects/p/note.md'));
  assert.equal(f.syncA().ok, true);
  write(f.b, 'projects/p/note.md', 'beta edit');
  const r = f.syncB();
  assert.equal(r.ok, true);
  assert.equal(r.merged, true);
  assert.equal(read(f.b, 'projects/p/note.md'), 'beta edit');
  assert.equal(f.syncA().ok, true);
  assert.equal(read(f.a, 'projects/p/note.md'), 'beta edit');
});

test('a note deleted locally and edited remotely comes back with the remote edit', (t) => {
  const f = fixture(t);
  sharedNote(f, 'projects/p/note.md', 'original');
  write(f.a, 'projects/p/note.md', 'alpha edit');
  assert.equal(f.syncA().ok, true);
  rmSync(join(f.b, 'projects/p/note.md'));
  const r = f.syncB();
  assert.equal(r.ok, true);
  assert.equal(read(f.b, 'projects/p/note.md'), 'alpha edit');
});

test('a staged secret is quarantined, never committed, and the committed version is restored', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/note.md', 'hello');
  f.syncA();
  write(f.a, 'projects/p/note.md', SECRET);
  const r = f.syncA({ now: new Date('2026-11-13T07:08:09Z') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.quarantined, ['projects/p/note.md']);
  assert.equal(r.committed, 0);
  assert.equal(read(f.a, 'projects/p/note.md'), 'hello');
  assert.doesNotMatch(sh(f.a, 'git', ['log', '-p', '--all']), /abcDEF1234567890/);
  assert.doesNotMatch(JSON.stringify(r), /abcDEF1234567890/);
  const qdir = join(f.stateA, 'quarantine');
  assert.deepEqual(readdirSync(qdir), ['20261113T070809Z__projects__p__note.md']);
  assert.equal(statSync(qdir).mode & 0o777, 0o700);
  assert.equal(statSync(join(qdir, '20261113T070809Z__projects__p__note.md')).mode & 0o777, 0o600);
  assert.equal(read(qdir, '20261113T070809Z__projects__p__note.md'), SECRET);
});

test('a secret in a new note removes its index line', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/MEMORY.md', '- [Keep](keep.md) — stays\n- [Leak](leak note.md) — has a token\n');
  write(f.a, 'projects/p/keep.md', 'fine');
  write(f.a, 'projects/p/leak note.md', `first line\n${SECRET}\n`);
  const r = f.syncA();
  assert.equal(r.ok, true);
  assert.deepEqual(r.quarantined, ['projects/p/leak note.md']);
  assert.equal(existsSync(join(f.a, 'projects/p/leak note.md')), false);
  assert.equal(read(f.a, 'projects/p/MEMORY.md'), '- [Keep](keep.md) — stays\n');
  assert.equal(sh(f.a, 'git', ['show', 'HEAD:projects/p/MEMORY.md']), '- [Keep](keep.md) — stays\n');
  assert.equal(sh(f.a, 'git', ['ls-files', '--', 'projects/p/leak note.md']), '');
  assert.doesNotMatch(sh(f.a, 'git', ['log', '-p', '--all']), /abcDEF1234567890/);
  assert.equal(sh(f.a, 'git', ['status', '--porcelain']), '');
});

test('a secret line in MEMORY.md is removed and kept in quarantine', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/MEMORY.md', `- [A](a.md) — one\n- ${SECRET}\n- [B](b.md) — two\n`);
  const r = f.syncA({ now: new Date('2026-11-13T07:08:09Z') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.quarantined, ['projects/p/MEMORY.md']);
  assert.equal(r.committed, 1);
  assert.equal(read(f.a, 'projects/p/MEMORY.md'), '- [A](a.md) — one\n- [B](b.md) — two\n');
  assert.doesNotMatch(sh(f.a, 'git', ['log', '-p', '--all']), /abcDEF1234567890/);
  const lines = join(f.stateA, 'quarantine', '20261113T070809Z__projects__p__MEMORY.md.lines');
  assert.equal(readFileSync(lines, 'utf8'), `- ${SECRET}\n`);
  assert.equal(statSync(lines).mode & 0o777, 0o600);
});

test('a private key in MEMORY.md is removed through its END line, or to the end without one', (t) => {
  const f = fixture(t);
  const begin = '-----BEGIN RSA ' + 'PRIVATE KEY-----';
  const end = '-----END RSA PRIVATE KEY-----';
  const body = 'MIIEowIBAAKCAQEAbodyLINE0123456789';
  write(f.a, 'projects/p/MEMORY.md', `- [A](a.md) — one\n${begin}\n${body}\n${body}2\n${end}\n- [B](b.md) — two\n`);
  write(f.a, 'projects/q/MEMORY.md', `- [C](c.md) — three\n${begin}\n${body}3\n`);
  const r = f.syncA({ now: new Date('2026-11-13T07:08:09Z') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.quarantined.sort(), ['projects/p/MEMORY.md', 'projects/q/MEMORY.md']);
  assert.equal(read(f.a, 'projects/p/MEMORY.md'), '- [A](a.md) — one\n- [B](b.md) — two\n');
  assert.equal(read(f.a, 'projects/q/MEMORY.md'), '- [C](c.md) — three\n');
  const history = sh(f.a, 'git', ['log', '-p', '--all']);
  assert.doesNotMatch(history, /bodyLINE/);
  assert.doesNotMatch(history, /PRIVATE KEY/);
  const qdir = join(f.stateA, 'quarantine');
  assert.equal(read(qdir, '20261113T070809Z__projects__p__MEMORY.md.lines'), `${begin}\n${body}\n${body}2\n${end}\n`);
  assert.equal(read(qdir, '20261113T070809Z__projects__q__MEMORY.md.lines'), `${begin}\n${body}3\n`);
});

test('a note with an invalid UTF-8 byte and a token is quarantined and never committed', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.a, 'projects/p'), { recursive: true });
  writeFileSync(join(f.a, 'projects/p/odd.md'), Buffer.concat([Buffer.from('note\n'), Buffer.from([0xff]), Buffer.from(`\n${SECRET}\n`)]));
  const r = f.syncA();
  assert.deepEqual(pick(r, 'ok', 'committed', 'quarantined'), { ok: true, committed: 0, quarantined: ['projects/p/odd.md'] });
  assert.equal(existsSync(join(f.a, 'projects/p/odd.md')), false);
  assert.doesNotMatch(sh(f.a, 'git', ['log', '-p', '--all', '--text']), /abcDEF1234567890/);
});

test('a clean file that is not valid UTF-8 is committed', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.a, 'projects/p'), { recursive: true });
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x89]), Buffer.from('plain bytes')]);
  writeFileSync(join(f.a, 'projects/p/blob.bin'), bytes);
  const r = f.syncA();
  assert.deepEqual(pick(r, 'ok', 'committed', 'pushed', 'quarantined'), { ok: true, committed: 1, pushed: true, quarantined: [] });
  assert.deepEqual(execGitBuffer(f.remote, ['show', 'main:projects/p/blob.bin']), bytes);
});

test('a file over 5 MB is quarantined and not committed', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/huge.md', 'a'.repeat(5 * 1024 * 1024 + 1));
  write(f.a, 'projects/p/small.md', 'fine');
  const r = f.syncA();
  assert.deepEqual(pick(r, 'ok', 'committed', 'quarantined'), { ok: true, committed: 1, quarantined: ['projects/p/huge.md'] });
  assert.equal(existsSync(join(f.a, 'projects/p/huge.md')), false);
  assert.equal(sh(f.remote, 'git', ['ls-tree', '-r', '--name-only', 'main', '--', 'projects/p']), 'projects/p/small.md\n');
  assert.equal(readdirSync(join(f.stateA, 'quarantine')).length, 1);
});

const quarantineFiles = (dir) => (existsSync(join(dir, 'quarantine')) ? readdirSync(join(dir, 'quarantine')) : []);
const remoteHistory = (f) => sh(f.remote, 'git', ['log', '-p', '--all']);

test('a hand commit with a token is rebuilt: the token goes to quarantine and the rest is pushed', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/manual.md', `by hand\n${SECRET}\n`);
  write(f.a, 'projects/p/plain.md', 'clean\n');
  sh(f.a, 'git', ['add', '--', 'projects/p/manual.md', 'projects/p/plain.md']);
  sh(f.a, 'git', ['commit', '-q', '-m', 'manual']);
  const r = f.syncA({ now: new Date('2026-11-13T07:08:09Z') });
  assert.deepEqual(pick(r, 'ok', 'pushed', 'error', 'quarantined'), { ok: true, pushed: true, error: null, quarantined: ['projects/p/manual.md'] });
  assert.deepEqual(quarantineFiles(f.stateA), ['20261113T070809Z__projects__p__manual.md']);
  assert.equal(read(join(f.stateA, 'quarantine'), '20261113T070809Z__projects__p__manual.md'), `by hand\n${SECRET}\n`);
  assert.equal(remoteFile(f, 'projects/p/plain.md'), 'clean\n');
  assert.doesNotMatch(remoteHistory(f), /abcDEF1234567890/);
  assert.doesNotMatch(JSON.stringify(r), /abcDEF1234567890/);
  assert.equal(headIsRemote(f.a), true);
});

test('a token added and later removed in hand commits is never pushed', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/later.md', `draft\n${SECRET}\n`);
  sh(f.a, 'git', ['add', '--', 'projects/p/later.md']);
  sh(f.a, 'git', ['commit', '-q', '-m', 'add with token']);
  write(f.a, 'projects/p/later.md', 'draft\n');
  sh(f.a, 'git', ['commit', '-q', '-am', 'remove token']);
  const r = f.syncA();
  assert.deepEqual(pick(r, 'ok', 'pushed', 'error', 'quarantined'), { ok: true, pushed: true, error: null, quarantined: [] });
  assert.equal(remoteFile(f, 'projects/p/later.md'), 'draft\n');
  assert.doesNotMatch(remoteHistory(f), /abcDEF1234567890/);
  assert.equal(read(f.a, 'projects/p/later.md'), 'draft\n');
});

test('a flagged index line already on the remote is taken out when a merge carries it into a new version', (t) => {
  const f = fixture(t);
  sharedNote(f, 'projects/p/MEMORY.md', '- [Base](base.md) - shared\n');
  append(f.b, 'projects/p/MEMORY.md', `- ${SECRET}\n`);
  sh(f.b, 'git', ['commit', '-q', '-am', 'by hand']);
  sh(f.b, 'git', ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  append(f.a, 'projects/p/MEMORY.md', '- [A](a.md) - from alpha\n');
  const r = f.syncA();
  assert.deepEqual(pick(r, 'ok', 'merged', 'pushed', 'error'), { ok: true, merged: true, pushed: true, error: null });
  const tip = remoteFile(f, 'projects/p/MEMORY.md');
  assert.doesNotMatch(tip, /abcDEF1234567890/);
  assert.match(tip, /from alpha/);
  assert.match(tip, /shared/);
  assert.equal(headIsRemote(f.a), true);
  assert.equal(quarantineFiles(f.stateA).filter((n) => n.endsWith('__projects__p__MEMORY.md.lines')).length, 1);
});

test('flagged content still present after the rebuild is refused and named, and nothing is pushed', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/plain.md', 'clean');
  const remoteBefore = sh(f.remote, 'git', ['rev-parse', 'main']);
  let rebuilds = 0;
  const afterRebuild = () => {
    rebuilds += 1;
    write(f.a, 'projects/p/中文 Secret Note.md', `${SECRET}\n`);
    sh(f.a, 'git', ['add', '-A']);
    sh(f.a, 'git', ['commit', '-q', '-m', 'hand commit']);
  };
  write(f.a, 'projects/p/first.md', `${SECRET}\n`);
  sh(f.a, 'git', ['add', '-A']);
  sh(f.a, 'git', ['commit', '-q', '-m', 'first hand commit']);
  const r = f.syncA({ afterRebuild });
  assert.equal(rebuilds, 1);
  assert.deepEqual(pick(r, 'ok', 'pushed'), { ok: false, pushed: false });
  assert.equal(r.error, 'unpushed commits contain flagged content: projects/p/中文 Secret Note.md (secret-assignment)');
  assert.doesNotMatch(JSON.stringify(r), /abcDEF1234567890/);
  assert.equal(sh(f.remote, 'git', ['rev-parse', 'main']), remoteBefore);
});

test('content already on origin/main is not scanned again before a push', (t) => {
  const f = fixture(t);
  write(f.b, 'projects/p/old.md', `${SECRET}\n`);
  sh(f.b, 'git', ['add', '--', 'projects/p/old.md']);
  sh(f.b, 'git', ['commit', '-q', '-m', 'pre-existing remote content']);
  sh(f.b, 'git', ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  assert.equal(f.syncA().ok, true);
  write(f.a, 'projects/p/new.md', 'clean');
  const r = f.syncA();
  assert.deepEqual(pick(r, 'ok', 'pushed', 'error'), { ok: true, pushed: true, error: null });
});

test('a stale index.lock from a killed run is removed', (t) => {
  const f = fixture(t);
  const lock = join(f.a, '.git', 'index.lock');
  writeFileSync(lock, '');
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  write(f.a, 'projects/p/note.md', 'hello');
  const r = f.syncA();
  assert.deepEqual(pick(r, 'ok', 'committed', 'pushed'), { ok: true, committed: 1, pushed: true });
  assert.equal(existsSync(lock), false);
});

test('a fresh index.lock is left alone and the run fails cleanly', (t) => {
  const f = fixture(t);
  const lock = join(f.a, '.git', 'index.lock');
  writeFileSync(lock, '');
  write(f.a, 'projects/p/note.md', 'hello');
  const r = f.syncA();
  assert.deepEqual(pick(r, 'ok', 'committed', 'pushed'), { ok: false, committed: 0, pushed: false });
  assert.match(r.error, /index\.lock/);
  assert.doesNotMatch(r.error, /\n/);
  assert.equal(existsSync(lock), true);
  rmSync(lock);
  assert.equal(f.syncA().ok, true);
});

test('git kills a command that exceeds timeoutMs', (t) => {
  const dir = tempDir(t);
  const r = git(dir, ['-c', 'alias.wait=!exec sleep 2', 'wait'], { allowFail: true, timeoutMs: 200 });
  assert.equal(r.code, TIMEOUT_CODE);
  assert.match(r.stderr, /^fatal: git wait timed out after 200 ms/);
});

test('a stalled fetch times out and fails the run', (t) => {
  const f = fixture(t);
  const fakeSsh = join(f.tmp, 'stall-ssh');
  writeFileSync(fakeSsh, '#!/bin/sh\nexec sleep 2\n');
  chmodSync(fakeSsh, 0o755);
  sh(f.a, 'git', ['config', 'core.sshCommand', fakeSsh]);
  sh(f.a, 'git', ['remote', 'set-url', 'origin', 'ssh://example.invalid/notes.git']);
  write(f.a, 'projects/p/note.md', 'hello');
  const started = Date.now();
  const r = f.syncA({ networkTimeoutMs: 300 });
  assert.ok(Date.now() - started < 1500);
  assert.deepEqual(pick(r, 'ok', 'committed', 'pushed'), { ok: false, committed: 1, pushed: false });
  assert.match(r.error, /^fatal: git fetch timed out after 300 ms$/);
});

test('an unreachable remote keeps the commit and reports failure, then recovers', (t) => {
  const f = fixture(t);
  sh(f.a, 'git', ['remote', 'set-url', 'origin', join(f.tmp, 'missing.git')]);
  write(f.a, 'projects/p/offline.md', 'x');
  const r = f.syncA();
  assert.equal(r.ok, false);
  assert.equal(r.committed, 1);
  assert.equal(r.pushed, false);
  assert.ok(r.error);
  assert.doesNotMatch(r.error, /\n/);
  assert.match(sh(f.a, 'git', ['log', '-1', '--format=%s']), /^sync\(alpha\): 1 file\(s\)/);
  sh(f.a, 'git', ['remote', 'set-url', 'origin', f.remote]);
  const again = f.syncA();
  assert.deepEqual(pick(again, 'ok', 'committed', 'pushed'), { ok: true, committed: 0, pushed: true });
  assert.equal(sh(f.remote, 'git', ['show', 'main:projects/p/offline.md']), 'x');
});

test('gives up after maxPushAttempts rejected pushes', (t) => {
  const f = fixture(t);
  const log = join(f.tmp, 'pushes.log');
  const hook = join(f.remote, 'hooks', 'pre-receive');
  writeFileSync(hook, `#!/bin/sh\necho attempt >> '${log}'\nexit 1\n`);
  chmodSync(hook, 0o755);
  write(f.a, 'projects/p/note.md', 'hello');
  const r = f.syncA();
  assert.equal(r.ok, false);
  assert.equal(r.pushed, false);
  assert.ok(r.error);
  assert.equal(readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 3);
});

test('temporary files are not committed', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/MEMORY.md.tmp.312989.47937f3bf2ba', 'partial');
  const r = f.syncA();
  assert.equal(r.ok, true);
  assert.equal(r.committed, 0);
});

test('refuses a clone that is not on main', (t) => {
  const f = fixture(t);
  sh(f.a, 'git', ['checkout', '-q', '-b', 'side']);
  write(f.a, 'projects/p/note.md', 'hello');
  const r = f.syncA();
  assert.equal(r.ok, false);
  assert.equal(r.committed, 0);
  assert.match(r.error, /main/);
  assert.match(r.error, /side/);
});

test('refuses a directory that is not a Git work tree', (t) => {
  const dir = tempDir(t);
  const r = runSync(cfg(join(dir, 'missing'), 'alpha', join(dir, 'state')));
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('aborts a merge left in progress by a crashed run', (t) => {
  const f = fixture(t);
  sharedNote(f, 'projects/p/note.md', 'v0');
  write(f.a, 'projects/p/note.md', 'alpha');
  f.syncA();
  write(f.b, 'projects/p/note.md', 'beta');
  sh(f.b, 'git', ['commit', '-q', '-am', 'local edit']);
  sh(f.b, 'git', ['fetch', '-q', 'origin']);
  assert.throws(() => sh(f.b, 'git', ['merge', '--no-edit', 'origin/main']));
  const r = f.syncB();
  assert.equal(r.ok, true);
  assert.deepEqual(r.conflicts, ['projects/p/note.md']);
  assert.equal(read(f.b, 'projects/p/note.md'), 'alpha');
  assert.equal(read(f.b, 'projects/p/note.conflict-beta.md'), 'beta');
});

test('writeStatus keeps lastSuccess across a failed run and counts quarantine and conflicts', (t) => {
  const { a } = makeRemoteAndClones(t);
  const stateDir = join(tempDir(t), 'state');
  const c = cfg(a, 'alpha', stateDir);
  write(a, 'projects/p/note.conflict-alpha.md', 'x');
  write(a, 'projects/q/other.conflict-beta-2.md', 'y');
  write(a, 'projects/q/plain.md', 'z');
  sh(a, 'git', ['add', '-A']);
  sh(a, 'git', ['commit', '-q', '-m', 'fixture']);
  write(stateDir, 'quarantine/20261113T070000Z__projects__p__x.md', 's');
  const okResult = { ok: true, committed: 1, merged: false, pushed: true, quarantined: [], conflicts: [], error: null };
  const failedResult = { ...okResult, ok: false, pushed: false, error: 'fatal: unreachable' };
  assert.equal(readStatus(c), null);
  const ok = writeStatus(c, okResult, new Date('2026-11-13T07:00:00Z'));
  const bad = writeStatus(c, failedResult, new Date('2026-11-13T07:02:00Z'));
  assert.equal(ok.lastSuccess, '2026-11-13T07:00:00.000Z');
  assert.equal(bad.lastSuccess, '2026-11-13T07:00:00.000Z');
  assert.equal(bad.lastRun, '2026-11-13T07:02:00.000Z');
  assert.equal(bad.error, 'fatal: unreachable');
  assert.equal(bad.quarantineCount, 1);
  assert.equal(bad.conflictCount, 2);
  assert.deepEqual(readStatus(c), bad);
  rmSync(join(stateDir, 'quarantine'), { recursive: true });
  assert.equal(writeStatus(c, okResult, new Date('2026-11-13T07:04:00Z')).quarantineCount, 0);
});

test('writeStatus starts with a null lastSuccess when the first run fails', (t) => {
  const { a } = makeRemoteAndClones(t);
  const c = cfg(a, 'alpha', join(tempDir(t), 'state'));
  const s = writeStatus(c, { ok: false, committed: 0, merged: false, pushed: false, quarantined: [], conflicts: [], error: 'x' });
  assert.equal(s.lastSuccess, null);
  assert.match(s.lastRun, /^\d{4}-\d\d-\d\dT/);
});

// Switches this test to a HOME whose Git configuration ignores `.project`, `*.md` and `tmp/`
// globally, as a user-level ignore file often does. Extra configuration lines are appended.
function useHostileHome(t, extra = '') {
  const home = tempDir(t);
  const excludes = join(home, 'global-ignore');
  writeFileSync(excludes, '.project\n*.md\ntmp/\n');
  writeFileSync(join(home, '.gitconfig'), `[user]\n\tname = test\n\temail = test@example.com\n[core]\n\texcludesFile = ${excludes}\n${extra}`);
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = previous; });
  return home;
}

const remoteFile = (f, rel) => sh(f.remote, 'git', ['show', `main:${rel}`]);

test('a note and a .project marker reach the remote and the other clone despite a global ignore file', (t) => {
  const f = fixture(t);
  useHostileHome(t);
  write(f.a, 'projects/p/note.md', 'hello\n');
  write(f.a, 'projects/p/.project', 'example.com/a/p\n');
  assert.equal(f.syncA().ok, true);
  assert.equal(remoteFile(f, 'projects/p/note.md'), 'hello\n');
  assert.equal(remoteFile(f, 'projects/p/.project'), 'example.com/a/p\n');
  assert.equal(f.syncB().ok, true);
  assert.equal(read(f.b, 'projects/p/note.md'), 'hello\n');
  assert.equal(read(f.b, 'projects/p/.project'), 'example.com/a/p\n');
});

test('a project folder named tmp syncs despite a global ignore file', (t) => {
  const f = fixture(t);
  useHostileHome(t);
  write(f.a, 'projects/tmp/note.md', 'in tmp\n');
  const r = f.syncA();
  assert.deepEqual(pick(r, 'ok', 'committed', 'pushed'), { ok: true, committed: 1, pushed: true });
  assert.equal(remoteFile(f, 'projects/tmp/note.md'), 'in tmp\n');
  assert.equal(f.syncB().ok, true);
  assert.equal(read(f.b, 'projects/tmp/note.md'), 'in tmp\n');
});

test('marker bound in clone A refuses a different repository in clone B after one sync each', (t) => {
  const f = fixture(t);
  useHostileHome(t);
  assert.equal(bindProject(join(f.a, 'projects/p'), 'example.com/a/p').reason, 'bound');
  assert.equal(f.syncA().ok, true);
  assert.equal(f.syncB().ok, true);
  assert.deepEqual(bindProject(join(f.b, 'projects/p'), 'example.com/b/p'), { ok: false, reason: 'mismatch', expected: 'example.com/a/p' });
});

test('the sync ignores signing settings and hooks from the global configuration', (t) => {
  const f = fixture(t);
  const hooks = join(f.tmp, 'hooks');
  mkdirSync(hooks);
  for (const name of ['pre-commit', 'commit-msg', 'pre-push', 'post-merge']) {
    writeFileSync(join(hooks, name), '#!/bin/sh\nexit 1\n');
    chmodSync(join(hooks, name), 0o755);
  }
  useHostileHome(t, `\thooksPath = ${hooks}\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /bin/false\n`);
  sharedNote(f, 'projects/p/note.md', 'v0\n');
  write(f.a, 'projects/p/note.md', 'alpha\n');
  write(f.b, 'projects/p/other.md', 'beta\n');
  assert.equal(f.syncA().ok, true);
  const r = f.syncB();
  assert.deepEqual(pick(r, 'ok', 'merged', 'pushed', 'error'), { ok: true, merged: true, pushed: true, error: null });
  assert.equal(remoteFile(f, 'projects/p/other.md'), 'beta\n');
});

test('quarantine leaves a sibling note alone when a flagged name contains glob characters', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/a.md', 'v1\n');
  write(f.a, 'projects/p/[ab].md', 'clean\n');
  assert.equal(f.syncA().ok, true);
  write(f.a, 'projects/p/a.md', 'v2\n');
  write(f.a, 'projects/p/[ab].md', `${SECRET}\n`);
  const r = f.syncA();
  assert.deepEqual(pick(r, 'ok', 'committed', 'quarantined'), { ok: true, committed: 1, quarantined: ['projects/p/[ab].md'] });
  assert.equal(read(f.a, 'projects/p/a.md'), 'v2\n');
  assert.equal(remoteFile(f, 'projects/p/a.md'), 'v2\n');
  assert.equal(read(f.a, 'projects/p/[ab].md'), 'clean\n');
  assert.equal(remoteFile(f, 'projects/p/[ab].md'), 'clean\n');
});

test('a flagged blob staged behind a clean working file is left out and reported', (t) => {
  const f = fixture(t);
  write(f.a, 'projects/p/n.md', 'clean\n');
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.a, input: `${SECRET}\n`, encoding: 'utf8' }).trim();
  sh(f.a, 'git', ['update-index', '--add', '--cacheinfo', `100644,${blob},projects/p/n.md`]);
  sh(f.a, 'git', ['update-index', '--assume-unchanged', 'projects/p/n.md']);
  write(f.a, 'projects/p/other.md', 'fine\n');
  const r = f.syncA();
  assert.deepEqual(pick(r, 'ok', 'committed', 'quarantined'), { ok: true, committed: 1, quarantined: ['projects/p/n.md'] });
  assert.equal(sh(f.a, 'git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'projects/p']), 'projects/p/other.md\n');
  assert.doesNotMatch(sh(f.remote, 'git', ['log', '-p', '--all']), /abcDEF1234567890/);
  assert.equal(read(f.a, 'projects/p/n.md'), 'clean\n');
});

test('a marker claimed differently on two machines keeps the remote one and is reported', (t) => {
  const f = fixture(t);
  const cfgB = cfg(f.b, 'beta', f.stateB);
  assert.equal(bindProject(join(f.a, 'projects/p'), 'example.com/a/p').reason, 'bound');
  assert.equal(bindProject(join(f.b, 'projects/p'), 'example.com/b/p').reason, 'bound');
  write(f.a, 'projects/p/from-a.md', 'a\n');
  write(f.b, 'projects/p/from-b.md', 'b\n');
  const first = f.syncA();
  assert.deepEqual(pick(first, 'ok', 'markerConflicts'), { ok: true, markerConflicts: [] });
  const losing = f.syncB();
  assert.deepEqual(pick(losing, 'ok', 'merged', 'pushed', 'conflicts', 'markerConflicts'),
    { ok: true, merged: true, pushed: true, conflicts: [], markerConflicts: ['projects/p'] });
  assert.equal(f.syncA().ok, true);
  for (const dir of [f.a, f.b]) assert.equal(read(dir, 'projects/p/.project'), 'example.com/a/p\n');
  assert.equal(remoteFile(f, 'projects/p/.project'), 'example.com/a/p\n');
  for (const dir of [f.a, f.b, f.remote]) {
    assert.doesNotMatch(sh(dir, 'git', ['ls-tree', '-r', '--name-only', 'main']), /\.project\.conflict-/);
  }
  assert.deepEqual(readdirSync(join(f.b, 'projects/p')).sort(), ['.project', 'from-a.md', 'from-b.md']);

  const status = writeStatus(cfgB, losing, new Date('2026-11-13T07:05:00Z'));
  assert.deepEqual(status.markerConflicts, ['projects/p']);
  const context = buildSessionContext({ config: cfgB, status, project: 'p', repoOk: true, now: new Date('2026-11-13T07:06:00Z') });
  assert.match(context, new RegExp(`\\nWARNING: 1 project folder\\(s\\) were claimed by a different repository on another machine\\. Notes written here before that may be mixed in; see ${f.stateB}/status\\.json\\.\\n`));
  // later runs keep the list until status.json is deleted
  const later = writeStatus(cfgB, f.syncB(), new Date('2026-11-13T07:07:00Z'));
  assert.deepEqual(later.markerConflicts, ['projects/p']);
  rmSync(join(f.stateB, 'status.json'));
  assert.deepEqual(writeStatus(cfgB, f.syncB()).markerConflicts, []);
});

test('writeStatus keeps the union of marker conflicts from every run', (t) => {
  const { a } = makeRemoteAndClones(t);
  const c = cfg(a, 'alpha', join(tempDir(t), 'state'));
  const base = { ok: true, committed: 0, merged: true, pushed: true, quarantined: [], conflicts: [], error: null };
  assert.deepEqual(writeStatus(c, { ...base, markerConflicts: ['projects/q'] }).markerConflicts, ['projects/q']);
  assert.deepEqual(writeStatus(c, { ...base, markerConflicts: ['projects/p', 'projects/q'] }).markerConflicts, ['projects/p', 'projects/q']);
  assert.deepEqual(writeStatus(c, { ...base, ok: false, markerConflicts: [] }).markerConflicts, ['projects/p', 'projects/q']);
});

test('a history rewritten on the remote is not merged or pushed back', (t) => {
  const f = fixture(t);
  sharedNote(f, 'projects/p/note.md', 'v0\n');
  const fresh = join(f.tmp, 'fresh');
  sh(f.tmp, 'git', ['init', '-q', '-b', 'main', fresh]);
  write(fresh, 'global/MEMORY.md', '');
  sh(fresh, 'git', ['add', '-A']);
  sh(fresh, 'git', ['commit', '-q', '-m', 'rewritten']);
  sh(fresh, 'git', ['push', '-q', '--force', f.remote, 'main']);
  const rewritten = sh(f.remote, 'git', ['rev-parse', 'main']);
  write(f.a, 'projects/p/new.md', 'written since\n');
  const error = `remote history was rewritten; re-clone ${f.a} (see README)`;
  for (let run = 0; run < 2; run += 1) {
    const r = f.syncA();
    assert.deepEqual(pick(r, 'ok', 'merged', 'pushed', 'error'), { ok: false, merged: false, pushed: false, error });
    assert.equal(sh(f.remote, 'git', ['rev-parse', 'main']), rewritten);
  }
  assert.equal(read(f.a, 'projects/p/new.md'), 'written since\n');
  assert.equal(sh(f.a, 'git', ['show', 'HEAD:projects/p/new.md']), 'written since\n');
  assert.equal(sh(f.a, 'git', ['status', '--porcelain']), '');
});

test('a private key in MEMORY.md written as a PGP block is removed through its END line', (t) => {
  const f = fixture(t);
  const begin = '-----BEGIN PGP ' + 'PRIVATE KEY BLOCK-----';
  const end = '-----END PGP PRIVATE KEY BLOCK-----';
  const body = 'lQOYBGVhbodyLINE0123456789';
  write(f.a, 'projects/p/MEMORY.md', `- [A](a.md) - one\n${begin}\n\n${body}\n${end}\n- [B](b.md) - two\n`);
  const r = f.syncA({ now: new Date('2026-11-13T07:08:09Z') });
  assert.deepEqual(pick(r, 'ok', 'quarantined'), { ok: true, quarantined: ['projects/p/MEMORY.md'] });
  assert.equal(read(f.a, 'projects/p/MEMORY.md'), '- [A](a.md) - one\n- [B](b.md) - two\n');
  assert.doesNotMatch(sh(f.a, 'git', ['log', '-p', '--all']), /bodyLINE|PRIVATE KEY/);
  assert.equal(read(join(f.stateA, 'quarantine'), '20261113T070809Z__projects__p__MEMORY.md.lines'), `${begin}\n\n${body}\n${end}\n`);
});
