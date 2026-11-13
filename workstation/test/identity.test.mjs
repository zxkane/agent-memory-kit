import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_MARKER, bindProject, markerTempName } from '../lib/identity.mjs';
import { tempDir } from './helpers.mjs';

const folder = (t) => join(tempDir(t), 'projects', 'app');

test('the marker file is called .project', () => {
  assert.equal(PROJECT_MARKER, '.project');
});

test('first repository binds the folder, the same repository matches', (t) => {
  const dir = folder(t);
  assert.deepEqual(bindProject(dir, 'example.com/a/app'), { ok: true, reason: 'bound', expected: null });
  assert.equal(readFileSync(join(dir, '.project'), 'utf8'), 'example.com/a/app\n');
  assert.deepEqual(bindProject(dir, 'example.com/a/app'), { ok: true, reason: 'match', expected: null });
});

test('a different repository with the same name is refused', (t) => {
  const dir = folder(t);
  bindProject(dir, 'example.com/a/app');
  assert.deepEqual(bindProject(dir, 'example.com/b/app'), { ok: false, reason: 'mismatch', expected: 'example.com/a/app' });
  assert.equal(readFileSync(join(dir, '.project'), 'utf8'), 'example.com/a/app\n');
});

test('a repository without an identity is refused and nothing is created', (t) => {
  const dir = folder(t);
  assert.deepEqual(bindProject(dir, null), { ok: false, reason: 'no-identity', expected: null });
  assert.equal(existsSync(dir), false);
});

test('a repository without an identity is refused by a bound folder, which stays as it was', (t) => {
  const dir = folder(t);
  bindProject(dir, 'example.com/a/app');
  assert.deepEqual(bindProject(dir, null), { ok: false, reason: 'no-identity', expected: null });
  assert.deepEqual(readdirSync(dir), ['.project']);
  assert.equal(readFileSync(join(dir, '.project'), 'utf8'), 'example.com/a/app\n');
});

test('an empty or blank marker counts as absent', (t) => {
  const dir = folder(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.project'), '  \n');
  assert.deepEqual(bindProject(dir, null), { ok: false, reason: 'no-identity', expected: null });
  assert.equal(readFileSync(join(dir, '.project'), 'utf8'), '  \n');
  assert.deepEqual(bindProject(dir, 'example.com/a/app'), { ok: true, reason: 'bound', expected: null });
  assert.equal(readFileSync(join(dir, '.project'), 'utf8'), 'example.com/a/app\n');
});

test('the marker content is compared after trimming', (t) => {
  const dir = folder(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.project'), '  example.com/a/app \r\n');
  assert.deepEqual(bindProject(dir, 'example.com/a/app'), { ok: true, reason: 'match', expected: null });
});

test('the temporary marker name matches the ignored pattern and no such file remains', (t) => {
  const dir = folder(t);
  assert.match(markerTempName(), /^\.project\.tmp\.\d+\.[0-9a-f]+$/);
  assert.notEqual(markerTempName(), markerTempName());
  bindProject(dir, 'example.com/a/app');
  assert.deepEqual(readdirSync(dir), ['.project']);
});

test('a marker that appears before publishing wins and is left untouched', (t) => {
  const dir = folder(t);
  const steps = { beforePublish: (marker) => writeFileSync(marker, 'example.com/a/app\n') };
  assert.deepEqual(bindProject(dir, 'example.com/b/app', steps), { ok: false, reason: 'mismatch', expected: 'example.com/a/app' });
  assert.equal(readFileSync(join(dir, '.project'), 'utf8'), 'example.com/a/app\n');
  assert.deepEqual(readdirSync(dir), ['.project']);
});

test('a marker that vanishes after publishing is retried once, then reported without an identity', (t) => {
  const dir = folder(t);
  let removed = 0;
  const steps = { afterPublish: (marker) => { rmSync(marker); removed += 1; } };
  assert.deepEqual(bindProject(dir, 'example.com/a/app', steps), { ok: false, reason: 'mismatch', expected: null });
  assert.equal(removed, 2);
  assert.deepEqual(readdirSync(dir), []);
});

test('a blank marker is replaced through the same no-overwrite step', (t) => {
  const dir = folder(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.project'), '\n');
  const steps = { beforePublish: (marker) => writeFileSync(marker, 'example.com/a/app\n') };
  assert.deepEqual(bindProject(dir, 'example.com/b/app', steps), { ok: false, reason: 'mismatch', expected: 'example.com/a/app' });
  assert.deepEqual(readdirSync(dir), ['.project']);
});

test('two processes binding the same empty folder: exactly one wins', async (t) => {
  const script = `
    const [dir, id, start] = process.argv.slice(1);
    const { bindProject } = await import(${JSON.stringify(new URL('../lib/identity.mjs', import.meta.url).href)});
    while (Date.now() < Number(start)) { /* spin until the shared start time */ }
    process.stdout.write(JSON.stringify(bindProject(dir, id)));`;
  const child = (dir, id, start) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script, dir, id, String(start)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exited ${code}`))));
  });
  for (let round = 0; round < 8; round += 1) {
    const dir = join(folder(t), `r${round}`);
    const start = Date.now() + 400;
    const results = await Promise.all([child(dir, 'example.com/a/app', start), child(dir, 'example.com/b/app', start)]);
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    const marker = readFileSync(join(dir, '.project'), 'utf8').trim();
    assert.equal(winners[0].reason, 'bound');
    assert.deepEqual(losers[0], { ok: false, reason: 'mismatch', expected: marker });
    assert.deepEqual(readdirSync(dir), ['.project']);
  }
});

const failingLink = (code) => () => {
  throw Object.assign(new Error(`link failed: ${code}`), { code });
};

test('without hard links the marker is created exclusively instead', (t) => {
  for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']) {
    const dir = folder(t);
    assert.deepEqual(bindProject(dir, 'example.com/a/app', { link: failingLink(code) }), { ok: true, reason: 'bound', expected: null }, code);
    assert.equal(readFileSync(join(dir, '.project'), 'utf8'), 'example.com/a/app\n', code);
    assert.deepEqual(readdirSync(dir), ['.project'], code);
  }
});

test('without hard links an existing marker is still never overwritten', (t) => {
  const dir = folder(t);
  const steps = {
    link: failingLink('EPERM'),
    beforePublish: (marker) => writeFileSync(marker, 'example.com/a/app\n'),
  };
  assert.deepEqual(bindProject(dir, 'example.com/b/app', steps), { ok: false, reason: 'mismatch', expected: 'example.com/a/app' });
  assert.equal(readFileSync(join(dir, '.project'), 'utf8'), 'example.com/a/app\n');
  assert.deepEqual(readdirSync(dir), ['.project']);
});

test('other link failures are not hidden', (t) => {
  const dir = folder(t);
  assert.throws(() => bindProject(dir, 'example.com/a/app', { link: failingLink('EIO') }), /link failed: EIO/);
  assert.deepEqual(readdirSync(dir), []);
});
