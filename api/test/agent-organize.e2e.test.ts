// End to end: agents write notes through the API, the Organize job for agent scopes
// (`run.sh consolidate organize --agents`, a separate process with a stand-in for the model) merges
// two of them, the API then serves only the merged note, and bridge down removes the retired file
// from the agents repository. One fake bucket backs all three: the API reads and writes it through
// a Store, the job through the fake-S3 preload (a file), bridge down through the S3 client.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../src/errors.ts';
import { memoryIndex } from '../src/ops/index.ts';
import { memoryRead } from '../src/ops/read.ts';
import { memorySearch } from '../src/ops/search.ts';
import { memoryWrite } from '../src/ops/write.ts';
import { createSnapshots } from '../src/snapshot.ts';
import type { Store } from '../src/store.ts';
import { runBridgeDown } from '../../workstation/lib/bridge-down.mjs';
import { createS3 } from '../../workstation/lib/s3.mjs';
import { createFakeS3 } from '../../workstation/test/fake-s3.mjs';
import { isolateGit, makeRemoteAndClones, sh, tempDir } from '../../workstation/test/helpers.mjs';

isolateGit();

const KIT = fileURLToPath(new URL('../../', import.meta.url));
const BUCKET = 'example-bucket';
const REGION = 'ap-northeast-1';
const credentials = { accessKeyId: 'ASIAEXAMPLEKEYID0001', secretAccessKey: 'example-signing-value', sessionToken: 'example-session-value' };
const md5 = (body: Buffer): string => `"${createHash('md5').update(body).digest('hex')}"`;
type Objects = Map<string, { body: Buffer; etag: string }>;

// The API's Store over the fake bucket's objects, with the same preconditions as S3.
function storeOver(objects: Objects): Store {
  return {
    async get(key, ifNoneMatch) {
      const o = objects.get(key);
      if (!o) return { status: 'missing' };
      if (ifNoneMatch !== undefined && ifNoneMatch === o.etag) return { status: 'not-modified' };
      return { status: 'ok', body: o.body.toString('utf8'), etag: o.etag };
    },
    async put(key, body, cond) {
      const o = objects.get(key);
      if (cond && 'ifNoneMatch' in cond && o) return { status: 'precondition-failed' };
      if (cond && 'ifMatch' in cond && (!o || o.etag !== cond.ifMatch)) return { status: 'precondition-failed' };
      const buf = Buffer.from(body);
      objects.set(key, { body: buf, etag: md5(buf) });
      return { status: 'ok', etag: md5(buf) };
    },
  };
}

const FACTS = 'Deploys always go through the staging stack first; staging listens on port 8443, production answers on port 443 behind the shared load balancer, and every release needs a signed changelog entry before promotion.';
const MERGED_CONTENT = `${FACTS} Steps: build, deploy to staging, check, promote.`;

// The stand-in for the model client: in the work folder of codex-alpha it merges deploy-steps into
// deploys; in any other scope it changes nothing.
const STUB = `#!${process.execPath}
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
if (basename(process.cwd()) !== 'agents-codex-alpha') {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, num_turns: 1, result: 'nothing' }) + '\\n');
  process.exit(0);
}
const notes = process.cwd() + '/notes';
writeFileSync(notes + '/deploys.md', ${JSON.stringify(['---', 'name: deploys', 'description: "How deploys go, with the steps"', 'metadata:', '  type: project', '---', '', MERGED_CONTENT, ''].join('\n'))});
writeFileSync(notes + '/deploy-steps.md', 'MOVED TO [[deploys]]\\n');
writeFileSync(notes + '/MEMORY.md', '- [deploys](deploys.md) — How deploys go, with the steps\\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, num_turns: 3, result: 'merged' }) + '\\n');
`;

test('notes written through the API are merged by organize --agents; the API and the mirror then hold only the merged note', async (t) => {
  const tmp = tempDir(t);
  const fake = createFakeS3();
  const objects = fake.objects as Objects;
  const store = storeOver(objects);

  // 1. Two agents' sessions wrote the same fact twice, and one note to another scope.
  await memoryWrite({ store }, { agent: 'codex-alpha', name: 'deploys', description: 'How deploys go', type: 'project', content: FACTS });
  await memoryWrite({ store }, { agent: 'codex-alpha', name: 'deploy-steps', description: 'Deploy steps', type: 'project', content: FACTS });
  await memoryWrite({ store }, { agent: 'claude-beta', name: 'other', description: 'Another agent', content: 'An unrelated fact of another agent.' });

  // 2. The mirror (bridge down) has copied both notes.
  const notes = makeRemoteAndClones(t);
  const agents = makeRemoteAndClones(t);
  writeFileSync(join(agents.b, '.agent-memory-mirror'), 'agents repository\n');
  sh(agents.b, 'git', ['add', '.agent-memory-mirror']);
  sh(agents.b, 'git', ['commit', '-q', '-m', 'chore: marker']);
  sh(agents.b, 'git', ['push', '-q', 'origin', 'main']);
  const bridgeConfig = {
    host: 'alpha', repoDir: notes.a, repoUrl: null, stateDir: join(tmp, 'bridge-state'), claudeDir: '/unused', staleAfterSeconds: 600,
    bridge: { bucket: BUCKET, region: REGION, up: false, down: true, agentsRepoDir: agents.a, agentsRepoUrl: null },
  };
  const s3 = createS3({ bucket: BUCKET, region: REGION, credentials, fetchImpl: fake.fetch, sleep: async () => {}, signal: undefined });
  const down = () => runBridgeDown({ config: bridgeConfig, s3, signal: new AbortController().signal, deadline: undefined });
  assert.equal((await down()).status, 'mirrored');
  const mirrored = (file: string) => join(agents.a, 'agents', 'codex-alpha', file);
  assert.ok(existsSync(mirrored('deploy-steps.md')));

  // 3. The Organize job for agent scopes runs as it would in a job, against the same bucket.
  const bucketFile = join(tmp, 'bucket.json');
  const save = () => writeFileSync(bucketFile, JSON.stringify(Object.fromEntries([...objects].map(([k, o]) => [k, { body: o.body.toString('base64'), etag: o.etag }]))));
  const load = () => {
    objects.clear();
    for (const [k, o] of Object.entries(JSON.parse(readFileSync(bucketFile, 'utf8')) as Record<string, { body: string; etag: string }>)) {
      objects.set(k, { body: Buffer.from(o.body, 'base64'), etag: o.etag });
    }
  };
  save();
  const home = join(tmp, 'home');
  mkdirSync(home);
  const stub = join(tmp, 'stub-model.mjs');
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  const configFile = join(tmp, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    enabled: true, host: 'job', repoDir: notes.b, stateDir: join(tmp, 'state'),
    consolidate: { command: stub, model: 'stub-model', agents: { bucket: BUCKET, region: REGION, credentials: 'environment' } },
  }));
  const r = spawnSync(join(KIT, 'workstation', 'run.sh'), ['consolidate', 'organize', '--agents'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', AGENT_MEMORY_CONFIG: configFile,
      NODE_OPTIONS: `--import ${join(KIT, 'workstation', 'test', 'fake-s3-preload.mjs')}`, FAKE_S3_FILE: bucketFile,
      AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey, AWS_SESSION_TOKEN: credentials.sessionToken,
    },
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^organize agents\/codex-alpha: applied, 3 change\(s\)/m);
  assert.match(r.stdout, /^organize agents\/claude-beta: no-change, 0 change\(s\)/m);
  load();

  // 4. The API serves the merged note only.
  const index = await memoryIndex({ store }, { scope: 'agents/codex-alpha' });
  assert.equal(index.index, '- [deploys](deploys.md) — How deploys go, with the steps\n');
  const search = await memorySearch({ snapshots: createSnapshots(store) }, { q: 'staging promote' });
  assert.deepEqual(search.results.map((x) => x.path), ['agents/codex-alpha/deploys.md']);
  await assert.rejects(memoryRead({ store }, { path: 'agents/codex-alpha/deploy-steps.md' }), (err: unknown) => err instanceof ApiError && err.status === 404);
  assert.match((await memoryRead({ store }, { path: 'agents/codex-alpha/deploys.md' })).content, /Steps: build/);
  assert.deepEqual((await memoryIndex({ store }, { scope: 'agents/claude-beta' })).index, '- [other](other.md) — Another agent\n');
  // The API can still write to the scope afterwards: the merged note's entry is a valid one.
  await memoryWrite({ store }, { agent: 'codex-alpha', name: 'later', description: 'A later note', content: 'Written after the run.' });
  assert.equal((await memorySearch({ snapshots: createSnapshots(store) }, { q: 'staging promote' })).total, 1);

  // 5. Bridge down mirrors the result: the retired file is gone from the agents repository.
  assert.equal((await down()).status, 'mirrored');
  assert.equal(existsSync(mirrored('deploy-steps.md')), false);
  assert.match(readFileSync(mirrored('deploys.md'), 'utf8'), /Steps: build/);
  assert.ok(existsSync(mirrored('later.md')));
});
