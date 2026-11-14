import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeRun, parseArgs } from '../bridge-run.mjs';
import { createFakeS3 } from './fake-s3.mjs';
import { isolateGit, isolatedEnv, makeRemoteAndClones, sh, tempDir } from './helpers.mjs';

isolateGit();

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-11-14T10:00:00Z');
const AT = NOW.toISOString();
const CREDS = { accessKeyId: 'EXAMPLEKEYID', secretAccessKey: 'example-signing-value', sessionToken: 'example-session-value' };
const NOTE = '---\nname: user-pref\ndescription: How the user likes answers\nmetadata:\n  type: user\n---\n\nShort answers.\n';

const block = (extra = {}) => ({
  bucket: 'example-bucket', region: 'ap-northeast-1', up: true, down: false, agentsRepoDir: null, agentsRepoUrl: null, roleArn: null,
  credentials: 'instance', ...extra,
});
const UP_OK = { ok: true, status: 'uploaded', error: null, at: AT, puts: 1 };
const DOWN_OK = { ok: true, status: 'mirrored', error: null, at: AT, written: 1 };
const DOWN_BAD = { ok: false, status: null, error: 'bridge down failed', at: AT };

// Runs bridgeRun with a fake runBridge and collects what it prints.
async function drive(argv, result, config = { stateDir: '/state', repoDir: '/notes', bridge: block() }) {
  const out = [];
  const err = [];
  const seen = [];
  const code = await bridgeRun({
    argv, config, now: NOW,
    deps: {
      runBridge: async (args) => { seen.push(args); return result; }, stdout: (t) => out.push(t), stderr: (t) => err.push(t),
    },
  });
  return { code, out: out.join(''), err: err.join(''), seen };
}

test('parseArgs: none gives 300; 10 to 1800 are accepted; everything else is refused', () => {
  assert.equal(parseArgs([]), 300);
  assert.equal(parseArgs(['--time-limit', '10']), 10);
  assert.equal(parseArgs(['--time-limit', '1800']), 1800);
  for (const bad of [['--time-limit'], ['--time-limit', '9'], ['--time-limit', '1801'], ['--time-limit', '1e3'], ['--time-limit', '30.5'],
    ['--time-limit', '-30'], ['--time-limit', ''], ['--time-limit', 'abc'], ['--time-limit', '030x'], ['--limit', '30'], ['30'],
    ['--time-limit', '30', 'x'], ['--time-limit', '99999999999999999999']]) {
    assert.equal(parseArgs(bad), null, JSON.stringify(bad));
  }
});

test('both steps ok: two lines in the fixed form, exit 0, a limit of 300 s and a successful sync are passed', async () => {
  const r = await drive([], { up: UP_OK, down: DOWN_OK });
  assert.equal(r.code, 0);
  assert.equal(r.out, `agent-memory bridge up: ${JSON.stringify(UP_OK)}\nagent-memory bridge down: ${JSON.stringify(DOWN_OK)}\n`);
  assert.equal(r.err, '');
  assert.equal(r.seen.length, 1);
  assert.equal(r.seen[0].limitMs, 300_000);
  assert.deepEqual(r.seen[0].syncResult, { ok: true });
  assert.equal(r.seen[0].processStart, undefined);
});

test('a step that is not configured prints no line', async () => {
  const up = await drive([], { up: UP_OK, down: null });
  assert.equal(up.out, `agent-memory bridge up: ${JSON.stringify(UP_OK)}\n`);
  assert.equal(up.code, 0);
  const down = await drive([], { up: null, down: DOWN_OK });
  assert.equal(down.out, `agent-memory bridge down: ${JSON.stringify(DOWN_OK)}\n`);
  assert.equal(down.code, 0);
});

test('a failed step is exit 1, and both lines are still printed', async () => {
  const r = await drive([], { up: UP_OK, down: DOWN_BAD });
  assert.equal(r.code, 1);
  assert.match(r.out, /^agent-memory bridge up: \{.*\}\nagent-memory bridge down: \{"ok":false.*\}\n$/);
  assert.equal((await drive([], { up: { ...UP_OK, ok: false }, down: null })).code, 1);
});

test('--time-limit sets the bridge limit in milliseconds', async () => {
  assert.equal((await drive(['--time-limit', '10'], { up: UP_OK, down: null })).seen[0].limitMs, 10_000);
  assert.equal((await drive(['--time-limit', '1800'], { up: UP_OK, down: null })).seen[0].limitMs, 1_800_000);
});

test('a bad --time-limit prints a usage line and exits 2 without running anything', async () => {
  for (const argv of [['--time-limit', '5'], ['--time-limit', '2000'], ['--time-limit', 'x'], ['--time-limit'], ['--bogus']]) {
    const r = await drive(argv, { up: UP_OK, down: null });
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.err, /^usage: run\.sh bridge \[--time-limit <seconds/);
    assert.equal(r.out, '');
    assert.equal(r.seen.length, 0);
  }
});

test('no bridge block (or no config): the fixed line and exit 2, nothing runs', async () => {
  for (const config of [null, { stateDir: '/state', repoDir: '/notes', bridge: null, bridgeProblem: 'bucket' }]) {
    const r = await drive([], { up: UP_OK, down: null }, config);
    assert.deepEqual([r.code, r.out, r.seen.length], [2, 'agent-memory: no bridge is configured.\n', 0]);
  }
});

test('a valid block that configures no step is treated like a missing block: the fixed line, exit 2, nothing runs', async () => {
  const r = await drive([], { up: null, down: null }, { stateDir: '/state', repoDir: '/notes', bridge: block({ up: false, down: false, agentsRepoDir: null }) });
  assert.deepEqual([r.code, r.out, r.err, r.seen.length], [2, 'agent-memory: no bridge is configured.\n', '', 0]);
});

test('a bridge that throws is "could not run", exit 1, and nothing of the error is printed', async () => {
  const out = [];
  const err = [];
  const code = await bridgeRun({
    argv: [], config: { bridge: block() }, now: NOW,
    deps: { runBridge: async () => { throw new Error('SECRET-IN-ERROR'); }, stdout: (t) => out.push(t), stderr: (t) => err.push(t) },
  });
  assert.equal(code, 1);
  assert.equal(err.join(''), 'agent-memory bridge could not run\n');
  assert.ok(!`${out}${err}`.includes('SECRET'));
});

// ---- the real bridge, a real clone and a fake bucket ----

test('a real run uploads and leaves the notes clone as it was; status.json is not written', async (t) => {
  const { a } = makeRemoteAndClones(t);
  mkdirSync(join(a, 'global'), { recursive: true });
  writeFileSync(join(a, 'global/user-pref.md'), NOTE);
  sh(a, 'git', ['add', '-A']);
  sh(a, 'git', ['commit', '-m', 'sync(alpha): notes']);
  sh(a, 'git', ['update-ref', 'refs/remotes/origin/main', sh(a, 'git', ['rev-parse', 'HEAD']).trim()]);
  const stateDir = join(tempDir(t), 'state');
  const fake = createFakeS3();
  const state = () => [sh(a, 'git', ['rev-parse', 'HEAD']), sh(a, 'git', ['ls-files', '-s']), sh(a, 'git', ['status', '--porcelain=v1', '--ignored']),
    sh(a, 'git', ['for-each-ref'])].join('\n--\n');
  const before = state();
  const out = [];
  const code = await bridgeRun({
    argv: [], now: NOW, config: { host: 'alpha', repoDir: a, stateDir, bridge: block() },
    deps: { stdout: (x) => out.push(x), bridgeDeps: { credentials: async () => CREDS, fetchImpl: fake.fetch } },
  });
  assert.equal(code, 0, out.join(''));
  const line = out.join('');
  assert.match(line, /^agent-memory bridge up: \{"ok":true,"status":"uploaded"/);
  assert.equal(line.split('\n').length, 2);
  assert.ok([...fake.objects.keys()].some((k) => k.startsWith('mem/')));
  assert.equal(state(), before);
  assert.equal(existsSync(join(stateDir, 'status.json')), false);
  assert.ok(readdirSync(stateDir).every((name) => name === 'bridge.json'), readdirSync(stateDir).join());
});

// ---- run.sh bridge ----

function launch(t, { config, args = [], before, env = {} } = {}) {
  const dir = tempDir(t);
  before?.(dir);
  const stateDir = join(dir, 'state');
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ enabled: true, host: 'alpha', repoDir: join(dir, 'clone'), stateDir, ...config }));
  const r = spawnSync('bash', [join(PKG, 'run.sh'), 'bridge', ...args], {
    encoding: 'utf8', env: isolatedEnv(dir, { AGENT_MEMORY_CONFIG: file, ...env }),
  });
  return { r, stateDir, dir };
}

const ENV_BRIDGE = { bridge: { up: true, bucket: 'example-bucket', region: 'ap-northeast-1', credentials: 'environment' } };

test('run.sh bridge with credentials "environment" and no variables: the step fails, one line, exit 1, no status.json', (t) => {
  const p = launch(t, { config: ENV_BRIDGE });
  assert.equal(p.r.status, 1, p.r.stderr);
  assert.match(p.r.stdout, /^agent-memory bridge up: \{"ok":false,"status":null,"error":"credentials failed: 0 NoEnvironment","at":"\d{4}-[^"]+Z"\}\n$/);
  assert.equal(p.r.stderr, '');
  assert.equal(existsSync(join(p.stateDir, 'status.json')), false);
});

test('run.sh bridge: no bridge block is exit 2; a bad --time-limit is exit 2 with a usage line', (t) => {
  const none = launch(t, { config: {} });
  assert.deepEqual([none.r.status, none.r.stdout], [2, 'agent-memory: no bridge is configured.\n']);
  const bad = launch(t, { config: ENV_BRIDGE, args: ['--time-limit', '5'] });
  assert.equal(bad.r.status, 2);
  assert.match(bad.r.stderr, /^usage: run\.sh bridge \[--time-limit/);
  assert.equal(bad.r.stdout, '');
});

test('run.sh bridge exits 75 at once while a sync holds the lock, and does nothing', (t) => {
  const p = launch(t, {
    config: ENV_BRIDGE,
    before: (dir) => {
      const locks = join(dir, '.local/state/agent-memory');
      mkdirSync(locks, { recursive: true });
      const file = join(locks, 'sync.lock');
      const holder = spawn('flock', ['-n', file, 'sleep', '60'], { stdio: 'ignore' });
      t.after(() => holder.kill());
      for (let i = 0; i < 200 && spawnSync('flock', ['-n', file, 'true']).status === 0; i++) spawnSync('sleep', ['0.025']);
      assert.notEqual(spawnSync('flock', ['-n', file, 'true']).status, 0, 'the lock is not held');
    },
  });
  assert.equal(p.r.status, 75);
  assert.equal(p.r.stderr, 'agent-memory: a sync is running; try again.\n');
  assert.equal(p.r.stdout, '');
  assert.equal(existsSync(p.stateDir), false);
});

test('run.sh bridge takes the sync lock without waiting, and the usage line lists the mode', () => {
  const source = readFileSync(join(PKG, 'run.sh'), 'utf8');
  const branch = /^ {4}bridge\)\n([\s\S]*?)\n {8};;/m.exec(source)?.[1] ?? '';
  assert.match(branch, /take_sync_lock/);
  assert.match(branch, /flock -n 9/);
  assert.match(branch, /exit 75/);
  assert.match(branch, /bridge-run\.mjs/);
  assert.match(source, /usage: run\.sh [^\n]*\| bridge\b/);
});
