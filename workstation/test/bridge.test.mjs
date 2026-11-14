import assert from 'node:assert/strict';
import test from 'node:test';
import { AwsError } from '../lib/aws.mjs';
import { bridgeAfterSync, bridgeLimitMs, runBridge } from '../lib/bridge.mjs';
import { runBridgeDown } from '../lib/bridge-down.mjs';
import { tempDir } from './helpers.mjs';

const NOW = new Date('2026-11-14T10:00:00Z');
const AT = NOW.toISOString();
const COMMIT = 'a'.repeat(40);
const OK_SYNC = { ok: true };

const bridgeBlock = (extra = {}) => ({
  bucket: 'example-bucket', region: 'ap-northeast-1', up: true, down: false, agentsRepoDir: null, agentsRepoUrl: null, ...extra,
});
const cfg = (bridge) => ({ host: 'alpha', repoDir: '/notes', stateDir: '/state', bridge });

const upResult = (extra = {}) => ({
  status: 'uploaded', commit: COMMIT, full: true, puts: 3, deletes: 1, skipped: [], foreign: 0, snapshotBytes: 1200, bodyLimit: 100000, ...extra,
});
const downResult = (extra = {}) => ({ status: 'mirrored', written: 2, removed: 1, skipped: [], commit: COMMIT, ...extra });

// Replaces everything that would reach AWS or the metadata service.
function fakes(over = {}) {
  const calls = { credentials: 0, createS3: [], up: [], down: [] };
  const deps = {
    credentials: async () => {
      calls.credentials += 1;
      return { accessKeyId: 'EXAMPLEKEYID', secretAccessKey: 'example-signing-value', sessionToken: 'example-session-value' };
    },
    createS3: (opts) => {
      calls.createS3.push(opts);
      return { id: 's3' };
    },
    runBridgeUp: async (args) => {
      calls.up.push(args);
      return upResult();
    },
    runBridgeDown: async (args) => {
      calls.down.push(args);
      return downResult();
    },
    ...over,
  };
  return { calls, deps };
}

const run = (config, deps, extra = {}) => runBridge({ config, syncResult: OK_SYNC, deps, now: NOW, ...extra });

test('no bridge block: nothing is attempted and credentials are not requested', async () => {
  const { calls, deps } = fakes();
  assert.equal(await run(cfg(null), deps), null);
  assert.deepEqual([calls.credentials, calls.createS3.length, calls.up.length, calls.down.length], [0, 0, 0, 0]);
});

test('a failed sync: nothing is attempted', async () => {
  const { calls, deps } = fakes();
  assert.equal(await runBridge({ config: cfg(bridgeBlock()), syncResult: { ok: false }, deps, now: NOW }), null);
  assert.deepEqual([calls.credentials, calls.up.length, calls.down.length], [0, 0, 0]);
});

test('up only: down is null and not run; credentials are requested once', async () => {
  const { calls, deps } = fakes();
  const r = await run(cfg(bridgeBlock()), deps);
  assert.equal(r.down, null);
  assert.equal(r.up.ok, true);
  assert.equal(calls.credentials, 1);
  assert.equal(calls.down.length, 0);
  assert.equal(calls.up.length, 1);
  assert.equal(calls.createS3.length, 1);
});

test('pull only: credentials are not requested and the step gets no S3 client', async () => {
  const { calls, deps } = fakes();
  const r = await run(cfg(bridgeBlock({ up: false, down: false, bucket: null, region: null, agentsRepoDir: '/agents' })), deps);
  assert.equal(r.up, null);
  assert.equal(r.down.ok, true);
  assert.equal(calls.credentials, 0);
  assert.equal(calls.createS3.length, 0);
  assert.equal(calls.up.length, 0);
  assert.equal(calls.down[0].s3, null);
});

test('up and down share one S3 client, one credentials request and one signal', async () => {
  const { calls, deps } = fakes();
  const config = cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents' }));
  const r = await run(config, deps);
  assert.equal(calls.credentials, 1);
  assert.equal(calls.createS3.length, 1);
  const s3Opts = calls.createS3[0];
  assert.equal(s3Opts.bucket, 'example-bucket');
  assert.equal(s3Opts.region, 'ap-northeast-1');
  assert.equal(s3Opts.credentials.accessKeyId, 'EXAMPLEKEYID');
  assert.ok(s3Opts.signal instanceof AbortSignal);
  assert.equal(calls.up[0].signal, s3Opts.signal);
  assert.equal(calls.down[0].signal, s3Opts.signal);
  assert.deepEqual(calls.up[0].s3, { id: 's3' });
  assert.deepEqual(calls.down[0].s3, { id: 's3' });
  assert.equal(calls.up[0].config, config);
  assert.equal(r.up.ok && r.down.ok, true);
});

test('records counts and the commit, never a path or a key', async () => {
  const { deps } = fakes({
    runBridgeUp: async () => upResult({
      skipped: [{ path: 'global/secret-name.md', reason: 'flagged' }, { path: 'global/b.md', reason: 'too-large' }, { path: 'global/c.md', reason: 'flagged' }],
    }),
    runBridgeDown: async () => downResult({
      skipped: [{ key: 'agents/x/y.md', reason: 'bad-key' }, { key: 'agents/a/b.md', reason: 'flagged' }], skippedMore: 7,
    }),
  });
  const r = await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents' })), deps);
  assert.deepEqual(r.up, {
    ok: true, status: 'uploaded', error: null, at: AT, commit: COMMIT, full: true, puts: 3, deletes: 1, foreign: 0,
    snapshotBytes: 1200, bodyLimit: 100000, skipped: { flagged: 2, 'too-large': 1 },
  });
  assert.deepEqual(r.down, {
    ok: true, status: 'mirrored', error: null, at: AT, commit: COMMIT, written: 2, removed: 1,
    skipped: { 'bad-key': 1, 'too-large': 0, flagged: 1 }, skippedMore: 7,
  });
  const text = JSON.stringify(r);
  assert.doesNotMatch(text, /secret-name|agents\/|global\//);
});

test('the success statuses are ok, the others are not and name themselves as the error', async () => {
  for (const status of ['unchanged', 'uploaded', 'verified', 'repaired']) {
    const { deps } = fakes({ runBridgeUp: async () => upResult({ status }) });
    const r = await run(cfg(bridgeBlock()), deps);
    assert.deepEqual([r.up.ok, r.up.status, r.up.error], [true, status, null]);
  }
  for (const status of ['behind', 'raced', 'not-synced', 'diverged']) {
    const { deps } = fakes({ runBridgeUp: async () => upResult({ status }) });
    const r = await run(cfg(bridgeBlock()), deps);
    assert.deepEqual([r.up.ok, r.up.status, r.up.error], [false, status, status]);
  }
  for (const status of ['unchanged', 'mirrored', 'pulled']) {
    const { deps } = fakes({ runBridgeDown: async () => downResult({ status }) });
    const r = await run(cfg(bridgeBlock({ up: false, bucket: null, region: null, agentsRepoDir: '/agents' })), deps);
    assert.deepEqual([r.down.ok, r.down.error], [true, null]);
  }
  const { deps } = fakes({ runBridgeDown: async () => downResult({ status: 'push-failed' }) });
  const r = await run(cfg(bridgeBlock({ up: false, bucket: null, region: null, agentsRepoDir: '/agents' })), deps);
  assert.deepEqual([r.down.ok, r.down.status, r.down.error], [false, 'push-failed', 'push-failed']);
});

test('an AwsError from up is recorded with its message and down still runs', async () => {
  const { calls, deps } = fakes({
    runBridgeUp: async () => {
      throw new AwsError('put', 403, 'AccessDenied');
    },
  });
  const r = await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents' })), deps);
  assert.deepEqual(r.up, { ok: false, status: null, error: 'put failed: 403 AccessDenied', at: AT });
  assert.equal(r.down.ok, true);
  assert.equal(calls.down.length, 1);
});

test('a failing down does not stop up from having run, and sync stays out of it', async () => {
  const { deps } = fakes({
    runBridgeDown: async () => {
      throw new AwsError('list', 503, 'SlowDown');
    },
  });
  const r = await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents' })), deps);
  assert.equal(r.up.ok, true);
  assert.deepEqual([r.down.ok, r.down.error], [false, 'list failed: 503 SlowDown']);
});

test('any other error is replaced by fixed text: no message, path, URL or stack', async () => {
  const leak = new Error('fatal: could not read from https://user:pw@example.com/private.git at /home/someone/notes');
  leak.stack = 'Error: leak\n    at /home/someone/file.mjs:1:1';
  leak.cause = new Error('cause with /secret/path');
  const { deps } = fakes({
    runBridgeUp: async () => {
      throw leak;
    },
    runBridgeDown: async () => {
      throw leak;
    },
  });
  const r = await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents' })), deps);
  assert.deepEqual(r.up, { ok: false, status: null, error: 'bridge up failed', at: AT });
  assert.deepEqual(r.down, { ok: false, status: null, error: 'bridge down failed', at: AT });
  assert.doesNotMatch(JSON.stringify(r), /example\.com|someone|secret/);
});

test("bridge down's own error keeps its fixed message", async (t) => {
  const dir = tempDir(t);
  const config = cfg(bridgeBlock({ up: false, bucket: null, region: null, agentsRepoDir: `${dir}/missing` }));
  const r = await runBridge({ config, syncResult: OK_SYNC, deps: { credentials: async () => assert.fail('no credentials') }, now: NOW });
  assert.deepEqual(r.down, { ok: false, status: null, error: 'the agents clone is not usable: the folder does not exist', at: AT });
  // The class is not exported: the real step is what proves the recognition above.
  await assert.rejects(runBridgeDown({ config: { ...config, bridge: { ...config.bridge, down: false } }, s3: null }), /not usable/);
});

test('an error message of 500 characters over several lines never reaches the record: one short fixed line', async () => {
  const long = new AwsError(`${'x'.repeat(500)}\nsecond line`, 500, 'Boom');
  const { deps } = fakes({
    runBridgeUp: async () => {
      throw long;
    },
  });
  const r = await run(cfg(bridgeBlock()), deps);
  assert.equal(r.up.error, 'bridge up failed');
  assert.ok(r.up.error.length <= 200 && !r.up.error.includes('\n'));
});

test('a step that never settles ends at the limit, and the step after it is not started', async () => {
  let downSignal;
  const { deps } = fakes({
    runBridgeUp: () => new Promise(() => {}),
    runBridgeDown: async ({ signal }) => {
      downSignal = signal;
      return downResult();
    },
  });
  const started = Date.now();
  const r = await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents' })), deps, { limitMs: 60 });
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(r.up, { ok: false, status: null, error: 'time limit', at: AT });
  // The limit has passed for everything: the second step does not start and is recorded the same way.
  assert.deepEqual(r.down, { ok: false, status: null, error: 'time limit', at: AT });
  assert.equal(downSignal, undefined);
});

test('a step that ends by the limit with its own time-limit error is recorded as "time limit"', async () => {
  const { deps } = fakes({
    runBridgeUp: ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new AwsError('bridge-up', 0, 'TimeLimit')));
    }),
  });
  const r = await run(cfg(bridgeBlock()), deps, { limitMs: 40 });
  assert.equal(r.up.error, 'time limit');
  assert.equal(r.up.ok, false);
});

test('the limit also covers the credentials request', async () => {
  const { calls, deps } = fakes({ credentials: () => new Promise(() => {}) });
  const r = await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents' })), deps, { limitMs: 40 });
  assert.equal(r.up.error, 'time limit');
  assert.equal(r.down.error, 'time limit');
  assert.equal(calls.up.length + calls.down.length, 0);
});

test('failing credentials: each step that needed S3 fails with the message, a pull-only step still runs', async () => {
  const failing = async () => {
    throw new AwsError('credentials', 0, 'Unavailable');
  };
  const a = fakes({ credentials: failing });
  const both = await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents' })), a.deps);
  assert.deepEqual(both.up, { ok: false, status: null, error: 'credentials failed: 0 Unavailable', at: AT });
  assert.deepEqual(both.down, { ok: false, status: null, error: 'credentials failed: 0 Unavailable', at: AT });
  assert.equal(a.calls.up.length + a.calls.down.length, 0);

  const b = fakes({ credentials: failing });
  const upPullOnly = await run(cfg(bridgeBlock({ agentsRepoDir: '/agents' })), b.deps);
  assert.equal(upPullOnly.up.error, 'credentials failed: 0 Unavailable');
  assert.equal(upPullOnly.down.ok, true);
  assert.equal(b.calls.down[0].s3, null);
});

test('a credentials failure that is not an AwsError gets the same fixed text', async () => {
  const { deps } = fakes({
    credentials: async () => {
      throw new Error('http://169.254.169.254/latest broke');
    },
  });
  const r = await run(cfg(bridgeBlock()), deps);
  assert.equal(r.up.error, 'credentials failed: 0 Unavailable');
});

test('a throwing createS3 is a failure of the steps that needed it, not a crash', async () => {
  const { deps } = fakes({
    createS3: () => {
      throw new Error('bad bucket https://example.com/x');
    },
  });
  const r = await run(cfg(bridgeBlock()), deps);
  assert.equal(r.up.ok, false);
  assert.doesNotMatch(r.up.error, /example\.com/);
});

// ---- bridgeAfterSync: the time budget around the whole run ----

test('bridgeAfterSync: no bridge configured gives null', async () => {
  assert.equal(await bridgeAfterSync({ config: cfg(null), syncResult: OK_SYNC, startedAt: Date.now() }), null);
});

test('bridgeAfterSync: after a failed sync the steps are left as they were (undefined) and unconfigured ones are null', async () => {
  const { calls, deps } = fakes();
  const r = await bridgeAfterSync({
    config: cfg(bridgeBlock()), syncResult: { ok: false }, startedAt: Date.now(), deps, now: NOW,
  });
  assert.deepEqual(r, { up: undefined, down: null });
  assert.equal(calls.credentials, 0);
});

test('bridgeLimitMs: min(75 s, 110 s minus the time already used)', () => {
  assert.equal(bridgeLimitMs(0), 75_000);
  assert.equal(bridgeLimitMs(35_000), 75_000);
  assert.equal(bridgeLimitMs(50_000), 60_000);
  assert.equal(bridgeLimitMs(105_000), 5_000);
  assert.equal(bridgeLimitMs(109_000), 1_000);
  assert.equal(bridgeLimitMs(200_000) < 5_000, true);
});

test('bridgeAfterSync: with less than 5 s left the bridge is not started and both steps are recorded', async () => {
  const { calls, deps } = fakes();
  const config = cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents' }));
  const r = await bridgeAfterSync({
    config, syncResult: OK_SYNC, startedAt: 0, clock: () => 106_000, deps, now: NOW,
  });
  const failed = { ok: false, status: null, error: 'no time left after the sync', at: AT };
  assert.deepEqual(r, { up: failed, down: failed });
  assert.equal(calls.credentials + calls.up.length + calls.down.length, 0);
});

test('bridgeAfterSync: an unconfigured step stays null when there is no time', async () => {
  const { deps } = fakes();
  const r = await bridgeAfterSync({
    config: cfg(bridgeBlock()), syncResult: OK_SYNC, startedAt: 0, clock: () => 109_000, deps, now: NOW,
  });
  assert.equal(r.down, null);
  assert.equal(r.up.error, 'no time left after the sync');
});

// ---- the deadline ----

const spin = (ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* blocks the event loop, as execFileSync does */ }
};

test('a step that blocks synchronously past the limit: the next step is not started and is recorded as not run', async () => {
  const { calls, deps } = fakes({
    runBridgeUp: async (args) => {
      calls.up.push(args);
      spin(300);
      return upResult({ status: 'unchanged' });
    },
  });
  const r = await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents' })), deps, { limitMs: 100 });
  assert.equal(r.up.ok, true);
  assert.deepEqual(r.down, { ok: false, status: null, error: 'time limit', at: AT });
  assert.equal(calls.down.length, 0);
});

test('both steps get the same deadline (epoch milliseconds) and the S3 client signal fires at it', async () => {
  const { calls, deps } = fakes();
  const before = Date.now();
  await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents' })), deps, { limitMs: 5000 });
  assert.equal(calls.up[0].deadline, calls.down[0].deadline);
  assert.ok(calls.up[0].deadline >= before + 5000 && calls.up[0].deadline <= Date.now() + 5000);
});

test('the deadline is the earlier of the bridge limit and 110 s after the process started', async () => {
  const { calls, deps } = fakes();
  const processStart = Date.now() - 100_000;
  await run(cfg(bridgeBlock()), deps, { processStart, limitMs: 75_000 });
  assert.equal(calls.up[0].deadline, processStart + 110_000);
});

test('a deadline that has passed: up is recorded as having no time left, nothing is started', async () => {
  const { calls, deps } = fakes();
  const r = await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents' })), deps, { processStart: Date.now() - 200_000 });
  assert.deepEqual(r.up, { ok: false, status: null, error: 'no time left after the sync', at: AT });
  assert.equal(r.down.ok, false);
  assert.equal(calls.up.length + calls.down.length, 0);
});

test('a pull-only machine with no time left: down is recorded as having no time left', async () => {
  const { calls, deps } = fakes();
  const config = cfg(bridgeBlock({ up: false, bucket: null, region: null, agentsRepoDir: '/agents' }));
  const r = await run(config, deps, { processStart: Date.now() - 200_000 });
  assert.equal(r.down.error, 'no time left after the sync');
  assert.equal(calls.down.length, 0);
});

test('a forged error object is not trusted: fixed fallback text', async () => {
  const forgedAws = Object.create(AwsError.prototype);
  forgedAws.message = 'any text at all /home/someone/x';
  const lookalike = { constructor: { name: 'BridgeDownError' }, message: 'the agents clone is not usable: /home/someone' };
  const wrongShape = new AwsError('put', 403, 'Access.Denied-With-Dots');
  const { deps } = fakes({
    runBridgeUp: async () => {
      throw forgedAws;
    },
    runBridgeDown: async () => {
      throw lookalike;
    },
  });
  const r = await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents' })), deps);
  assert.equal(r.up.error, 'bridge up failed');
  assert.equal(r.down.error, 'bridge down failed');
  const { deps: d2 } = fakes({
    runBridgeUp: async () => {
      throw wrongShape;
    },
  });
  assert.equal((await run(cfg(bridgeBlock()), d2)).up.error, 'bridge up failed');
});

test("an error of bridge down's own class keeps its text only when it is one of the known fixed texts", async () => {
  const { BridgeDownError } = await import('../lib/bridge-down.mjs');
  const known = new BridgeDownError('bridge down failed while trying to list');
  const unknown = new BridgeDownError('something with /home/someone/path in it');
  const config = cfg(bridgeBlock({ up: false, bucket: null, region: null, agentsRepoDir: '/agents' }));
  const a = await run(config, fakes({ runBridgeDown: async () => { throw known; } }).deps);
  const b = await run(config, fakes({ runBridgeDown: async () => { throw unknown; } }).deps);
  assert.equal(a.down.error, 'bridge down failed while trying to list');
  assert.equal(b.down.error, 'bridge down failed');
});

test('a forged result is cut down to the allow-lists: unknown status, non-integer counts, odd commit', async () => {
  const { deps } = fakes({
    runBridgeUp: async () => ({
      status: 'all good, see /home/someone', commit: 'not-a-commit', puts: '3', deletes: -1, foreign: 1.5, snapshotBytes: Infinity,
      bodyLimit: null, full: 'yes', skipped: 'x', extra: 'ignored',
    }),
    runBridgeDown: async () => ({ status: 'up' + 'loaded', written: {}, removed: [], skipped: [{ reason: 'flagged' }], commit: COMMIT }),
  });
  const r = await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents' })), deps);
  assert.deepEqual(r.up, {
    ok: false, status: null, error: 'bridge up failed', at: AT, full: false, puts: 0, deletes: 0, foreign: 0, snapshotBytes: 0,
    bodyLimit: 0, skipped: { flagged: 0, 'too-large': 0 },
  });
  // A status word of the other step is not a status of this one.
  assert.equal(r.down.ok, false);
  assert.equal(r.down.status, null);
  assert.equal(r.down.error, 'bridge down failed');
  assert.equal(r.down.written, 0);
  assert.equal(r.down.commit, COMMIT);
});

test('bridgeAfterSync: exactly 5 s left still starts the bridge', async () => {
  const { calls, deps } = fakes();
  const r = await bridgeAfterSync({
    config: cfg(bridgeBlock()), syncResult: OK_SYNC, startedAt: 0, clock: () => 105_000, deps, now: NOW,
  });
  assert.equal(r.up.ok, true);
  assert.equal(calls.up.length, 1);
});

// ---- roleArn: the dedicated role ----

const ROLE = 'arn:aws:iam::123456789012:role/example-bridge';
const ROLE_CREDS = { accessKeyId: 'ROLEKEYID', secretAccessKey: 'role-signing-value', sessionToken: 'role-session-value', expiration: '2026-11-14T10:15:00Z' };

function roleFakes(over = {}) {
  const exchange = [];
  const { calls, deps } = fakes({
    assumeRole: async (args) => {
      exchange.push(args);
      return ROLE_CREDS;
    },
    ...over,
  });
  return { calls, deps, exchange };
}

test('roleArn: S3 gets the exchanged credentials once per run, never the instance credentials', async () => {
  const { calls, deps, exchange } = roleFakes();
  const r = await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents', roleArn: ROLE })), deps);
  assert.equal(r.up.ok && r.down.ok, true);
  assert.equal(exchange.length, 1);
  assert.equal(exchange[0].roleArn, ROLE);
  assert.equal(exchange[0].sessionName, 'agent-memory-bridge');
  assert.equal(exchange[0].region, 'ap-northeast-1');
  assert.equal(exchange[0].credentials.accessKeyId, 'EXAMPLEKEYID');
  assert.ok(exchange[0].signal instanceof AbortSignal);
  assert.equal(exchange[0].signal, calls.createS3[0].signal);
  assert.equal(calls.createS3.length, 1);
  assert.equal(calls.createS3[0].credentials, ROLE_CREDS);
  assert.ok(!JSON.stringify(calls.createS3).includes('EXAMPLEKEYID'));
});

test('roleArn: a failed exchange fails every step that needs S3 and no S3 client is built; the pull-only step is not affected', async () => {
  const { calls, deps } = roleFakes({ assumeRole: async () => { throw new AwsError('sts', 403, 'AccessDenied'); } });
  const r = await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents', roleArn: ROLE })), deps);
  assert.deepEqual(r.up, { ok: false, status: null, error: 'sts failed: 403 AccessDenied', at: AT });
  assert.deepEqual(r.down, { ok: false, status: null, error: 'sts failed: 403 AccessDenied', at: AT });
  assert.deepEqual([calls.createS3.length, calls.up.length, calls.down.length], [0, 0, 0]);
  // Pull only: no S3, so no exchange, and the step still runs.
  const pull = roleFakes({ assumeRole: async () => assert.fail('no exchange') });
  const p = await run(cfg(bridgeBlock({ up: false, bucket: null, region: null, agentsRepoDir: '/agents', roleArn: ROLE })), pull.deps);
  assert.equal(p.down.ok, true);
  assert.equal(pull.calls.credentials, 0);
});

test('roleArn: with down false, a failed exchange fails up, the pull still runs without S3, and no S3 client is built', async () => {
  const { calls, deps } = roleFakes({ assumeRole: async () => { throw new AwsError('sts', 403, 'AccessDenied'); } });
  const r = await run(cfg(bridgeBlock({ down: false, agentsRepoDir: '/agents', roleArn: ROLE })), deps);
  assert.deepEqual(r.up, { ok: false, status: null, error: 'sts failed: 403 AccessDenied', at: AT });
  assert.equal(calls.down.length, 1);
  assert.equal(calls.down[0].s3, null);
  assert.equal(calls.createS3.length, 0);
});

test('roleArn: an error of the exchange that is not an AwsError never reaches the record', async () => {
  const { calls, deps } = roleFakes({ assumeRole: async () => { throw new Error('SECRET-IN-ERROR'); } });
  const r = await run(cfg(bridgeBlock({ down: true, agentsRepoDir: '/agents', roleArn: ROLE })), deps);
  assert.equal(r.up.ok, false);
  assert.equal(r.down.ok, false);
  assert.equal(r.up.error, 'credentials failed: 0 Unavailable');
  assert.equal(r.down.error, 'credentials failed: 0 Unavailable');
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.equal(calls.createS3.length, 0);
});

test('roleArn: an exchange that does not finish in time is a time limit and no S3 client is built', async () => {
  const { calls, deps } = roleFakes({ assumeRole: () => new Promise(() => {}) });
  const r = await run(cfg(bridgeBlock({ roleArn: ROLE })), deps, { limitMs: 30 });
  assert.deepEqual(r.up, { ok: false, status: null, error: 'time limit', at: AT });
  assert.equal(calls.createS3.length, 0);
});

test('roleArn: a failed instance-credentials request fails the steps and no exchange is attempted', async () => {
  const { calls, deps, exchange } = roleFakes({ credentials: async () => { throw new AwsError('credentials', 0, 'Unavailable'); } });
  const r = await run(cfg(bridgeBlock({ roleArn: ROLE })), deps);
  assert.equal(r.up.error, 'credentials failed: 0 Unavailable');
  assert.deepEqual([exchange.length, calls.createS3.length], [0, 0]);
});

test('no roleArn: the instance credentials are used as before and nothing is exchanged', async () => {
  const { calls, deps, exchange } = roleFakes();
  await run(cfg(bridgeBlock()), deps);
  assert.equal(exchange.length, 0);
  assert.equal(calls.createS3[0].credentials.accessKeyId, 'EXAMPLEKEYID');
});

test('roleArn: the exchange sends the run fetch, so a test can keep it off the network', async () => {
  const fetchImpl = async () => assert.fail('not used here');
  const { exchange, deps } = roleFakes({ fetchImpl });
  await run(cfg(bridgeBlock({ roleArn: ROLE })), deps);
  assert.equal(exchange[0].fetchImpl, fetchImpl);
});
