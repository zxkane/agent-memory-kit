// The two bridge steps against a deadline: every blocking Git network command ends at it, and is not
// started when too little time is left. A Git wrapper on the PATH stalls the commands under test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AwsError } from '../lib/aws.mjs';
import { networkLimit as networkLimitDown, runBridgeDown } from '../lib/bridge-down.mjs';
import { networkLimit as networkLimitUp, runBridgeUp } from '../lib/bridge-up.mjs';
import { createS3 } from '../lib/s3.mjs';
import { createFakeS3 } from './fake-s3.mjs';
import { isolateGit, makeRemoteAndClones, sh, tempDir } from './helpers.mjs';

isolateGit();

const credentials = { accessKeyId: 'EXAMPLEKEYID', secretAccessKey: 'example-signing-value', sessionToken: 'example-session-value' };
const NOW = new Date('2026-11-14T10:00:00Z');
const REC = 'index/bridge.json';
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

// Puts a `git` in front of the real one. `stall` lists the Git commands that sleep (until killed);
// every `fetch` and `push` is logged.
function stallingGit(t, stall) {
  const dir = tempDir(t);
  const log = join(dir, 'network.log');
  writeFileSync(join(dir, 'git'), [
    '#!/bin/sh',
    'for a in "$@"; do',
    '  case "$a" in fetch|push) printf "%s\\n" "$a" >> "$GIT_NETWORK_LOG" ;; esac',
    '  case " $GIT_STALL " in *" $a "*) exec sleep 30 ;; esac',
    'done',
    'exec "$REAL_GIT" "$@"',
    '',
  ].join('\n'));
  chmodSync(join(dir, 'git'), 0o755);
  const saved = { PATH: process.env.PATH, GIT_STALL: process.env.GIT_STALL, GIT_NETWORK_LOG: process.env.GIT_NETWORK_LOG, REAL_GIT: process.env.REAL_GIT };
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.GIT_STALL = stall.join(' ');
  process.env.GIT_NETWORK_LOG = log;
  process.env.REAL_GIT = REAL_GIT;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  return { network: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

const timeLimit = (err) => err instanceof AwsError && err.code === 'TimeLimit';

// ---- bridge up ----

function upFixture(t) {
  const { a, b } = makeRemoteAndClones(t);
  const fake = createFakeS3();
  const controller = new AbortController();
  const s3 = createS3({
    bucket: 'example-bucket', region: 'ap-northeast-1', credentials, fetchImpl: fake.fetch,
    now: () => NOW, sleep: async () => {}, signal: controller.signal,
  });
  const config = {
    host: 'alpha', repoDir: a, repoUrl: null, stateDir: join(tempDir(t), 'state'), claudeDir: '/unused', staleAfterSeconds: 600,
    bridge: { bucket: 'example-bucket', region: 'ap-northeast-1', up: true, down: false, agentsRepoDir: null, agentsRepoUrl: null },
  };
  mkdirSync(join(a, 'global'), { recursive: true });
  writeFileSync(join(a, 'global', 'one.md'), 'one\n');
  sh(a, 'git', ['add', '-A']);
  sh(a, 'git', ['commit', '-m', 'sync(alpha): notes']);
  sh(a, 'git', ['push', '-q', 'origin', 'main']);
  // A record naming a commit this clone does not have makes bridge up fetch.
  const unknownRecord = () => s3.put(REC, JSON.stringify({ version: 1, commit: 'f'.repeat(40), host: 'beta', time: NOW.toISOString() }));
  const run = (opts) => runBridgeUp({ config, s3, now: NOW, signal: controller.signal, recheckMs: 0, ...opts });
  return { b, run, unknownRecord };
}

test('bridge up: its fetch ends at the deadline, not at its own 20 s limit', async (t) => {
  const f = upFixture(t);
  const git = stallingGit(t, ['fetch']);
  await f.unknownRecord();
  const started = Date.now();
  await assert.rejects(f.run({ deadline: Date.now() + 4000 }), timeLimit);
  const took = Date.now() - started;
  assert.ok(took >= 2500 && took < 9000, `took ${took} ms`);
  assert.deepEqual(git.network(), ['fetch']);
});

test('bridge up: with less than 2 s left, or none, no Git network command is started', async (t) => {
  const f = upFixture(t);
  const git = stallingGit(t, ['fetch']);
  await f.unknownRecord();
  for (const deadline of [Date.now() - 1000, Date.now() + 1000]) {
    await assert.rejects(f.run({ deadline }), timeLimit);
  }
  assert.deepEqual(git.network(), []);
});

test('bridge up: without a deadline the fetch is not limited by one (it works as before)', async (t) => {
  const f = upFixture(t);
  const git = stallingGit(t, []);
  await f.unknownRecord();
  const result = await f.run({});
  assert.equal(result.status, 'uploaded');
  assert.deepEqual(git.network(), ['fetch']);
});

// ---- bridge down ----

function downFixture(t) {
  const notes = makeRemoteAndClones(t);
  const agents = makeRemoteAndClones(t);
  const fake = createFakeS3();
  const controller = new AbortController();
  const s3 = createS3({
    bucket: 'example-bucket', region: 'ap-northeast-1', credentials, fetchImpl: fake.fetch,
    now: () => NOW, sleep: async () => {}, signal: controller.signal,
  });
  const config = {
    host: 'alpha', repoDir: notes.a, repoUrl: null, stateDir: join(tempDir(t), 'state'), claudeDir: '/unused', staleAfterSeconds: 600,
    bridge: { bucket: 'example-bucket', region: 'ap-northeast-1', up: false, down: true, agentsRepoDir: agents.a, agentsRepoUrl: null },
  };
  // The marker, published from the other clone of the agents repository.
  sh(agents.b, 'git', ['fetch', '-q', 'origin']);
  sh(agents.b, 'git', ['reset', '-q', '--hard', 'origin/main']);
  mkdirSync(dirname(join(agents.b, '.agent-memory-mirror')), { recursive: true });
  writeFileSync(join(agents.b, '.agent-memory-mirror'), 'agents repository\n');
  sh(agents.b, 'git', ['add', '.agent-memory-mirror']);
  sh(agents.b, 'git', ['commit', '-m', 'chore: marker']);
  sh(agents.b, 'git', ['push', 'origin', 'main']);
  const put = (key, body) => fake.objects.set(key, { body: Buffer.from(body), etag: `"${execFileSync('md5sum', { input: body, encoding: 'utf8' }).slice(0, 32)}"` });
  const run = (opts) => runBridgeDown({ config, s3, signal: controller.signal, ...opts });
  return { run, put };
}

test("bridge down: its fetch ends at the deadline, not at its own 20 s limit, and nothing in the clone changed", async (t) => {
  const f = downFixture(t);
  const git = stallingGit(t, ['fetch']);
  const started = Date.now();
  await assert.rejects(f.run({ deadline: Date.now() + 4000 }), timeLimit);
  const took = Date.now() - started;
  assert.ok(took >= 2500 && took < 9000, `took ${took} ms`);
  assert.deepEqual(git.network(), ['fetch']);
});

test('bridge down: the update of the remote ends at the deadline, not at its own 30 s limit', async (t) => {
  const f = downFixture(t);
  const git = stallingGit(t, ['push']);
  f.put('agents/alpha-bot/one.md', '---\nname: one\n---\n\nOne.\n');
  const started = Date.now();
  await assert.rejects(f.run({ deadline: Date.now() + 4500 }), timeLimit);
  const took = Date.now() - started;
  assert.ok(took < 9000, `took ${took} ms`);
  assert.deepEqual(git.network(), ['fetch', 'push']);
});

test('bridge down: with less than 2 s left, or none, no Git network command is started', async (t) => {
  const f = downFixture(t);
  const git = stallingGit(t, ['fetch', 'push']);
  for (const deadline of [Date.now() - 1000, Date.now() + 1000]) {
    await assert.rejects(f.run({ deadline }), timeLimit);
  }
  assert.deepEqual(git.network(), []);
});

test('bridge down: without a deadline it works as before', async (t) => {
  const f = downFixture(t);
  stallingGit(t, []);
  f.put('agents/alpha-bot/one.md', '---\nname: one\n---\n\nOne.\n');
  assert.equal((await f.run({})).status, 'mirrored');
});

test('the time limit of a network command ignores a deadline that is not a finite number', () => {
  for (const networkLimit of [networkLimitUp, networkLimitDown]) {
    for (const deadline of [undefined, null, NaN, Infinity, -Infinity, '123', 'soon', {}, []]) {
      assert.equal(networkLimit(20_000, deadline), 20_000, String(deadline));
    }
    assert.ok(networkLimit(20_000, Date.now() + 5_000) <= 5_000);
    assert.ok(networkLimit(20_000, Date.now() + 5_000) > 3_000);
    assert.equal(networkLimit(2_500, Date.now() + 60_000), 2_500);
    assert.throws(() => networkLimit(20_000, Date.now() + 1_000), timeLimit);
    assert.throws(() => networkLimit(20_000, Date.now() - 1_000), timeLimit);
  }
});
