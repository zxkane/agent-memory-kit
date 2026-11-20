import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { labelAgentScopes } from '../lib/agent-labels.mjs';
import { SNAPSHOT_KEY, STATE_KEY, listAgentScopes, scopeDigest } from '../lib/agent-scopes.mjs';
import { AwsError } from '../lib/aws.mjs';
import { parseDomains } from '../lib/domains.mjs';
import { createS3 } from '../lib/s3.mjs';
import { createFakeS3 } from './fake-s3.mjs';

const credentials = { accessKeyId: 'EXAMPLEKEYID', secretAccessKey: 'example-signing-value', sessionToken: 'example-session-value' };
const md5 = (body) => `"${createHash('md5').update(body).digest('hex')}"`;
const STARTED = new Date('2026-11-22T06:00:00.000Z');
const MARKDOWN = 'text/markdown; charset=utf-8';

// A note file as the memory API composes it (api/src/note-file.ts), and the same note with the
// label the pass writes into it.
const apiNote = (name, description, content) =>
  ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`, 'metadata:', '  type: reference', '---', '', content].join('\n') + '\n';
const labeled = (name, description, content, label) =>
  apiNote(name, description, content).replace('  type: reference\n', `  type: reference\n  domain: ${label}\n`);

const DEPLOYS = ['How deploys go', 'Deploys go through the staging stack first.'];
const STEPS = ['Deploy steps', 'Build, deploy to staging, check, promote.'];
const FAMILY = ['Family plans', 'The weekend trip is planned for June.'];

// The scopes of a bucket: agent -> note name -> [description, content, label or null].
const SCOPES = {
  'codex-alpha': { deploys: [...DEPLOYS, null], 'deploy-steps': [...STEPS, 'work'] },
  'example-agent': { family: [...FAMILY, null] },
};

// A bucket as the memory API writes it: the notes, each scope's MEMORY.md and the search snapshot,
// whose entries carry no label (the API writes none).
function bucket(scopes = SCOPES) {
  const fake = createFakeS3();
  const client = createS3({ bucket: 'example-bucket', region: 'ap-northeast-1', credentials, fetchImpl: fake.fetch, sleep: async () => {} });
  const put = (key, body) => fake.objects.set(key, { body: Buffer.from(body), etag: md5(body) });
  const text = (key) => fake.objects.get(key)?.body.toString('utf8');
  const doc = () => JSON.parse(text(SNAPSHOT_KEY));
  const entries = [];
  for (const [agent, notes] of Object.entries(scopes)) {
    const lines = [];
    for (const [name, [description, content, label]] of Object.entries(notes)) {
      put(`agents/${agent}/${name}.md`, label ? labeled(name, description, content, label) : apiNote(name, description, content));
      entries.push({ path: `agents/${agent}/${name}.md`, name, description, type: 'reference', body: content });
      lines.push(`- [${name}](${name}.md) — ${description}`);
    }
    put(`agents/${agent}/MEMORY.md`, `${lines.join('\n')}\n`);
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  put(SNAPSHOT_KEY, JSON.stringify({ version: 1, notes: entries }));
  return {
    fake, client, put, text,
    s3: async () => client,
    etag: (key) => fake.objects.get(key)?.etag,
    entry: (path) => doc().notes.find((n) => n.path === path),
    scope: (agent) => JSON.parse(text(STATE_KEY) ?? '{"scopes":{}}').scopes[agent],
    setState: (scopesState) => put(STATE_KEY, JSON.stringify({ version: 1, scopes: scopesState })),
    writes: () => fake.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE'),
    digest: async (agent) => scopeDigest((await listAgentScopes(client)).get(agent)),
    // The label of a note in its search entry, as the pass writes it.
    labelEntry(path, label) {
      const next = doc();
      next.notes = next.notes.map((n) => (n.path === path ? { ...n, domain: label } : n));
      put(SNAPSHOT_KEY, JSON.stringify(next));
    },
    // What an older kit's Organize does to the search entries: it rewrites them without labels.
    stripLabels() {
      const next = doc();
      next.notes = next.notes.map(({ domain: _label, ...n }) => n);
      put(SNAPSHOT_KEY, JSON.stringify(next));
    },
    // An agent's write through the API, in the API's order: the search entry, then the note.
    agentWrites(agent, name, description, content) {
      const path = `agents/${agent}/${name}.md`;
      const next = doc();
      next.notes = [...next.notes.filter((n) => n.path !== path), { path, name, description, type: 'reference', body: content }]
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      put(SNAPSHOT_KEY, JSON.stringify(next));
      put(path, apiNote(name, description, content));
    },
  };
}

// A stand-in for label-client's labelBatch: each note gets the label `labels` gives its path
// (`general` when none), with a reason the output must never show. A call whose number (from 1)
// is in `fails` fails as an unreachable endpoint does.
function model(labels = {}, { fails = [], onCall = () => {} } = {}) {
  const calls = [];
  const labelBatch = async ({ notes, persona, label, token }) => {
    calls.push({ paths: notes.map((n) => n.path), persona, model: label.model, token });
    onCall(calls.length);
    if (fails.includes(calls.length)) {
      return { ok: false, error: 'Mantle Responses HTTP 503', transport: true, usage: { input: 0, output: 0 }, costUsd: 0, requests: 1 };
    }
    const given = new Map(notes.map((n) => [n.id, { label: labels[n.path] ?? 'general', reason: `MODEL-REASON for ${n.path}` }]));
    return { ok: true, labels: given, usage: { input: 1000, output: 50 }, costUsd: 0.0014, requests: 1 };
  };
  return { labelBatch, calls, paths: () => calls.map((c) => c.paths) };
}

const CONFIG = {
  consolidate: { maxBudgetUsd: 5, label: { model: 'example-label-model', batchNotes: 19, inputUsdPerMillion: 1.1, outputUsdPerMillion: 5.5 } },
};
const domainsOf = (extra = {}) => parseDomains(JSON.stringify({ version: 1, defaults: {}, exceptions: {}, ...extra })).value;

// A token maker that counts its calls.
function tokens() {
  const made = [];
  const token = async () => {
    made.push(Date.now());
    return { token: 'example-label-token', tokenAt: Date.now() };
  };
  return { token, made };
}

function pass(b, m, { opts = {}, domains = domainsOf(), token = tokens().token, signal, config = CONFIG, s3For = b.s3 } = {}) {
  return labelAgentScopes({
    config, opts: { agentNames: [], all: false, dryRun: false, ...opts }, s3For, started: STARTED,
    domains, persona: 'The owner is an example tester.', token, labelBatch: m.labelBatch, signal,
  });
}

const reads = (b, from) => b.fake.requests.slice(from).filter((r) => r.method === 'GET' && r.key.startsWith('agents/')).map((r) => r.key);

// Makes the `nth` request `method key` (from 1) fail on every attempt of the client, with HTTP 503.
function failOn(b, method, key, nth = 1) {
  let seen = 0;
  b.fake.onRequest((r) => {
    if (r.method === method && r.key === key && ++seen === nth) b.fake.failNext(3, 503);
  });
}

test('the first run records labeled notes by ETag', async () => {
  const b = bucket();
  const steps = b.etag('agents/codex-alpha/deploy-steps.md');
  const m = model({ 'agents/codex-alpha/deploys.md': 'work', 'agents/example-agent/family.md': 'personal' });
  const t = tokens();
  const out = await pass(b, m, { token: t.token });
  assert.equal(out.failed, false, out.lines.join('\n'));
  // Every note was read; only the ones without a label go to the model, one batch per scope, with
  // the run's one token, the persona and the label model.
  assert.deepEqual(m.paths(), [['agents/codex-alpha/deploys.md'], ['agents/example-agent/family.md']]);
  assert.equal(t.made.length, 1);
  assert.deepEqual(m.calls.map((c) => [c.token, c.model, c.persona]), Array(2).fill(['example-label-token', 'example-label-model', 'The owner is an example tester.']));
  assert.equal(b.text('agents/codex-alpha/deploys.md'), labeled('deploys', ...DEPLOYS, 'work'));
  assert.equal(b.text('agents/example-agent/family.md'), labeled('family', ...FAMILY, 'personal'));
  // The labeled note is recorded as it was found, by its ETag; nothing writes it.
  assert.equal(b.etag('agents/codex-alpha/deploy-steps.md'), steps);
  assert.ok(!b.writes().some((r) => r.key === 'agents/codex-alpha/deploy-steps.md'));
  assert.deepEqual(b.scope('codex-alpha').labels, { 'deploy-steps.md': steps, 'deploys.md': b.etag('agents/codex-alpha/deploys.md') });
  assert.deepEqual(b.scope('example-agent').labels, { 'family.md': b.etag('agents/example-agent/family.md') });
  assert.equal(b.scope('codex-alpha').lastLabel, STARTED.toISOString());
  // One line per scope, then the report without the model's reasons.
  assert.deepEqual(out.lines, [
    'label: 2 note(s) sent to the model, USD 0.00, 2 request(s)',
    'label agents/codex-alpha: applied, 1 label(s) written, 0 unchanged',
    'label agents/example-agent: applied, 1 label(s) written, 0 unchanged',
    '## agents/codex-alpha',
    '',
    'Labels set or changed:',
    '- agents/codex-alpha/deploys.md: unlabeled → work',
    '',
    'Labels after this run: 2 work, 0 personal, 0 general',
    '',
    '## agents/example-agent',
    '',
    'Labels set or changed:',
    '- agents/example-agent/family.md: unlabeled → personal',
    '',
    'Labels after this run: 0 work, 1 personal, 0 general',
  ]);
  assert.doesNotMatch(out.lines.join('\n'), /MODEL-REASON|example-label-token/);
  // The next run finds nothing touched: it reads no note, makes no token and asks no model.
  const from = b.fake.requests.length;
  const again = await pass(b, m, { token: t.token });
  assert.deepEqual(reads(b, from), []);
  assert.equal(t.made.length, 1);
  assert.equal(m.calls.length, 2);
  assert.deepEqual(again, { failed: false, lines: ['label agents/codex-alpha: nothing to do', 'label agents/example-agent: nothing to do'] });
  assert.deepEqual(b.scope('codex-alpha').labels, { 'deploy-steps.md': steps, 'deploys.md': b.etag('agents/codex-alpha/deploys.md') });
});

test('a touched note is written with If-Match and its entry gets the domain', async () => {
  const b = bucket();
  await pass(b, model({ 'agents/codex-alpha/deploys.md': 'work' }));
  assert.equal(b.entry('agents/example-agent/family.md').domain, 'general');
  // An agent rewrites deploys.md through the API: a new version, without a label.
  b.agentWrites('codex-alpha', 'deploys', 'How deploys go now', 'Deploys now go through a canary first.');
  const listed = b.etag('agents/codex-alpha/deploys.md');
  const m = model({ 'agents/codex-alpha/deploys.md': 'personal' });
  const from = b.fake.requests.length;
  const out = await pass(b, m);
  assert.equal(out.failed, false, out.lines.join('\n'));
  // Only the touched note is read and sent.
  assert.deepEqual(reads(b, from), ['agents/codex-alpha/deploys.md']);
  assert.deepEqual(m.paths(), [['agents/codex-alpha/deploys.md']]);
  // It is written over the version that was listed and read, as a note.
  const puts = b.fake.requests.slice(from).filter((r) => r.method === 'PUT');
  const note = puts.filter((r) => r.key === 'agents/codex-alpha/deploys.md');
  assert.equal(note.length, 1);
  assert.equal(note[0].headers['if-match'], listed);
  assert.equal(note[0].headers['content-type'], MARKDOWN);
  assert.equal(b.text('agents/codex-alpha/deploys.md'), labeled('deploys', 'How deploys go now', 'Deploys now go through a canary first.', 'personal'));
  // Its search entry is the note's, with the label; the other entries keep theirs.
  assert.deepEqual(b.entry('agents/codex-alpha/deploys.md'), {
    path: 'agents/codex-alpha/deploys.md', name: 'deploys', description: 'How deploys go now', type: 'reference',
    body: 'Deploys now go through a canary first.', domain: 'personal',
  });
  assert.equal(b.entry('agents/example-agent/family.md').domain, 'general');
  // One conditional update of the snapshot and one of the record, for this scope; every write conditional.
  assert.deepEqual(puts.map((r) => r.key), ['agents/codex-alpha/deploys.md', SNAPSHOT_KEY, STATE_KEY, STATE_KEY]);
  for (const r of puts) assert.ok(r.headers['if-match'] !== undefined || r.headers['if-none-match'] === '*', r.key);
  assert.equal(b.scope('codex-alpha').labels['deploys.md'], b.etag('agents/codex-alpha/deploys.md'));
  assert.equal(out.lines[1], 'label agents/codex-alpha: applied, 1 label(s) written, 0 unchanged');
  // The agent's version carried no label.
  assert.ok(out.lines.includes('- agents/codex-alpha/deploys.md: unlabeled → personal'), out.lines.join('\n'));
});

test("an agent's write meanwhile wins", async () => {
  const b = bucket();
  const theirs = ['Rewritten by an agent', 'An agent rewrote this just now.'];
  // Right before the label is written over deploys.md, an agent writes the note again.
  let armed = true;
  b.fake.onRequest(({ method, key }) => {
    if (armed && method === 'PUT' && key === 'agents/codex-alpha/deploys.md') {
      armed = false;
      b.agentWrites('codex-alpha', 'deploys', ...theirs);
    }
  });
  const out = await pass(b, model({ 'agents/codex-alpha/deploys.md': 'work', 'agents/example-agent/family.md': 'personal' }));
  assert.equal(out.failed, false, out.lines.join('\n'));
  // The agent's version stays, with the entry the API wrote for it, and the note has no record entry.
  assert.equal(b.text('agents/codex-alpha/deploys.md'), apiNote('deploys', ...theirs));
  assert.deepEqual(b.entry('agents/codex-alpha/deploys.md'), {
    path: 'agents/codex-alpha/deploys.md', name: 'deploys', description: theirs[0], type: 'reference', body: theirs[1],
  });
  assert.deepEqual(Object.keys(b.scope('codex-alpha').labels), ['deploy-steps.md']);
  // The rest of the run goes on.
  assert.equal(b.text('agents/example-agent/family.md'), labeled('family', ...FAMILY, 'personal'));
  assert.ok(out.lines.includes('label agents/codex-alpha: no-change, 0 label(s) written, 0 unchanged, 1 not written'), out.lines.join('\n'));
  assert.ok(out.lines.includes('- agents/codex-alpha/deploys.md: not written; an agent wrote it meanwhile'), out.lines.join('\n'));
  // The next run labels the agent's version.
  const next = model({ 'agents/codex-alpha/deploys.md': 'work' });
  await pass(b, next);
  assert.deepEqual(next.paths(), [['agents/codex-alpha/deploys.md']]);
  assert.equal(b.text('agents/codex-alpha/deploys.md'), labeled('deploys', ...theirs, 'work'));

  // A note that changed between the listing and its read is not sent: it waits for the next run.
  const c = bucket();
  let read = true;
  c.fake.onRequest(({ method, key }) => {
    if (read && method === 'GET' && key === 'agents/example-agent/family.md') {
      read = false;
      c.agentWrites('example-agent', 'family', 'Family plans, changed', 'The trip moved to July.');
    }
  });
  const m = model();
  const res = await pass(c, m);
  assert.deepEqual(m.paths(), [['agents/codex-alpha/deploys.md']]);
  assert.equal(c.text('agents/example-agent/family.md'), apiNote('family', 'Family plans, changed', 'The trip moved to July.'));
  assert.deepEqual(c.scope('example-agent').labels, {});
  assert.ok(res.lines.includes('- agents/example-agent/family.md: not written; an agent wrote it meanwhile'), res.lines.join('\n'));
});

test('the Organize digest moves with the labels', async () => {
  const b = bucket();
  // codex-alpha is as Organize left it; example-agent changed since Organize saw it.
  const organized = await b.digest('codex-alpha');
  b.setState({ 'codex-alpha': { organizedDigest: organized, lastOrganize: '2026-11-19T06:00:00.000Z' }, 'example-agent': { organizedDigest: 'f'.repeat(64) } });
  await pass(b, model());
  // Labels never make a scope due: its record moves to the content the labels left.
  assert.notEqual(await b.digest('codex-alpha'), organized);
  assert.equal(b.scope('codex-alpha').organizedDigest, await b.digest('codex-alpha'));
  assert.equal(b.scope('codex-alpha').lastOrganize, '2026-11-19T06:00:00.000Z');
  // A scope that was due stays due.
  assert.equal(b.scope('example-agent').organizedDigest, 'f'.repeat(64));

  // An agent's write during the pass is never absorbed: the record moves to the listing the pass
  // read with its own writes, which is not what the scope now holds.
  const c = bucket();
  c.setState({ 'codex-alpha': { organizedDigest: await c.digest('codex-alpha') } });
  const listed = (await listAgentScopes(c.client)).get('codex-alpha');
  let armed = true;
  c.fake.onRequest(({ method, key }) => {
    if (armed && method === 'PUT' && key === 'agents/codex-alpha/deploys.md') {
      armed = false;
      c.agentWrites('codex-alpha', 'fresh', 'New note', 'An agent wrote this new note meanwhile.');
    }
  });
  await pass(c, model());
  const moved = c.scope('codex-alpha').organizedDigest;
  assert.equal(moved, scopeDigest(listed.map((f) => (f.file === 'deploys.md' ? { ...f, etag: c.etag('agents/codex-alpha/deploys.md') } : f))));
  assert.notEqual(moved, await c.digest('codex-alpha'), 'Organize finds the scope due');
});

test('exceptions and --all', async () => {
  const b = bucket();
  const exceptions = { 'agents/codex-alpha/deploy-steps.md': 'personal', 'agents/codex-alpha/gone.md': 'work', 'projects/example-project/x.md': 'work' };
  const m = model();
  const first = await pass(b, m, { domains: domainsOf({ exceptions }) });
  // The note with an exception gets its label from code; the model never sees it.
  assert.deepEqual(m.paths(), [['agents/codex-alpha/deploys.md'], ['agents/example-agent/family.md']]);
  assert.equal(b.text('agents/codex-alpha/deploy-steps.md'), labeled('deploy-steps', ...STEPS, 'personal'));
  assert.equal(b.entry('agents/codex-alpha/deploy-steps.md').domain, 'personal');
  assert.ok(first.lines.includes('- agents/codex-alpha/deploy-steps.md: work → personal (exception)'), first.lines.join('\n'));
  // An exception of the run's scopes that names no note is listed; one of another scope is not.
  const report = first.lines.join('\n');
  assert.match(report, /^Exceptions that name no note:\n- agents\/codex-alpha\/gone\.md$/m);
  assert.doesNotMatch(report, /example-project/);
  assert.equal(b.scope('codex-alpha').labels['deploy-steps.md'], b.etag('agents/codex-alpha/deploy-steps.md'));

  // Every later run reads the exception's note again; it holds the label, so nothing is written.
  let from = b.fake.requests.length;
  const quiet = await pass(b, m, { domains: domainsOf({ exceptions }) });
  assert.deepEqual(reads(b, from), ['agents/codex-alpha/deploy-steps.md']);
  assert.deepEqual(b.fake.requests.slice(from).filter((r) => r.method === 'PUT').map((r) => r.key), [STATE_KEY, STATE_KEY]);
  assert.equal(m.calls.length, 2);
  assert.equal(quiet.lines[0], 'label agents/codex-alpha: no-change, 0 label(s) written, 1 unchanged');
  // The owner changes the exception: the next run writes it, still without the model.
  const changed = { 'agents/codex-alpha/deploy-steps.md': 'general' };
  await pass(b, m, { domains: domainsOf({ exceptions: changed }) });
  assert.equal(b.text('agents/codex-alpha/deploy-steps.md'), labeled('deploy-steps', ...STEPS, 'general'));
  assert.equal(m.calls.length, 2);

  // --all sends every note of the run's scopes, except the exception's, whatever the record says.
  const all = model({ 'agents/codex-alpha/deploys.md': 'work' });
  from = b.fake.requests.length;
  const out = await pass(b, all, { domains: domainsOf({ exceptions: changed }), opts: { all: true } });
  assert.deepEqual(all.paths(), [['agents/codex-alpha/deploys.md'], ['agents/example-agent/family.md']]);
  assert.deepEqual(reads(b, from), ['agents/codex-alpha/deploy-steps.md', 'agents/codex-alpha/deploys.md', 'agents/example-agent/family.md']);
  assert.equal(b.text('agents/codex-alpha/deploys.md'), labeled('deploys', ...DEPLOYS, 'work'));
  assert.equal(out.lines[1], 'label agents/codex-alpha: applied, 1 label(s) written, 1 unchanged');
  // An --all run that does not label a note it took drops that note's entry, which still matched it.
  const failing = model({}, { fails: [1] });
  const stopped = await pass(b, failing, { domains: domainsOf({ exceptions: changed }), opts: { all: true, agentNames: ['codex-alpha'] } });
  assert.equal(stopped.failed, true);
  assert.deepEqual(Object.keys(b.scope('codex-alpha').labels), ['deploy-steps.md']);
  assert.ok(stopped.lines.includes('- agents/codex-alpha/deploys.md: the model call failed (Mantle Responses HTTP 503)'), stopped.lines.join('\n'));
  // A plain run sends it again.
  const next = model({ 'agents/codex-alpha/deploys.md': 'work' });
  await pass(b, next, { domains: domainsOf({ exceptions: changed }) });
  assert.deepEqual(next.paths(), [['agents/codex-alpha/deploys.md']]);
});

test('a dry run writes nothing', async () => {
  const b = bucket();
  const before = [...b.fake.objects].map(([key, o]) => [key, o.etag]);
  const m = model({ 'agents/codex-alpha/deploys.md': 'work' });
  const out = await pass(b, m, { opts: { dryRun: true } });
  assert.equal(out.failed, false);
  assert.deepEqual(m.paths(), [['agents/codex-alpha/deploys.md'], ['agents/example-agent/family.md']]);
  assert.deepEqual(b.writes(), []);
  assert.deepEqual([...b.fake.objects].map(([key, o]) => [key, o.etag]), before);
  assert.deepEqual(out.lines.slice(0, 3), [
    'label: 2 note(s) sent to the model, USD 0.00, 2 request(s)',
    'label agents/codex-alpha: dry-run, 1 label(s) to set or change',
    'label agents/example-agent: dry-run, 1 label(s) to set or change',
  ]);
  assert.ok(out.lines.includes('- agents/codex-alpha/deploys.md: unlabeled → work'));
  assert.ok(out.lines.includes('- agents/example-agent/family.md: unlabeled → general'));
  // A dry run prints in the job log too: never the model's reasons.
  assert.doesNotMatch(out.lines.join('\n'), /MODEL-REASON/);
  // Nothing moved: the next run is still a first run.
  const again = model();
  await pass(b, again, { opts: { dryRun: true } });
  assert.equal(again.calls.length, 2);
});

// Notes the memory API could have written (at most 50,000 bytes of text each) that bring the
// search entries of codex-alpha to `240000 - room` bytes. Each is labeled already, with the label
// in its entry, so a first run only confirms it.
function fill(b, room) {
  const BASE = 47_500;
  const filler = (i, size) => [`filler-${i}`, `Filler ${i}`, 'f'.repeat(size)];
  const write = ([name, description, content]) => {
    b.agentWrites('codex-alpha', name, description, content);
    b.put(`agents/codex-alpha/${name}.md`, labeled(name, description, content, 'general'));
    b.labelEntry(`agents/codex-alpha/${name}.md`, 'general');
  };
  for (let i = 1; i <= 5; i++) write(filler(i, BASE));
  const entries = () => JSON.parse(b.text(SNAPSHOT_KEY)).notes.filter((n) => n.path.startsWith('agents/codex-alpha/'));
  const size = BASE + 240_000 - room - Buffer.byteLength(JSON.stringify(entries()));
  assert.ok(size > BASE && size <= 50_000, `filler size ${size}`);
  write(filler(5, size));
  assert.equal(Buffer.byteLength(JSON.stringify(entries())), 240_000 - room);
}

const scopeBytes = (b) => Buffer.byteLength(JSON.stringify(JSON.parse(b.text(SNAPSHOT_KEY)).notes.filter((n) => n.path.startsWith('agents/codex-alpha/'))));

test("a note that no label lets fit into the memory API's limits is not sent to the model", async () => {
  // The longest label, `personal`, adds 20 bytes to an entry: with 19 bytes of room it would not fit.
  const b = bucket();
  b.labelEntry('agents/codex-alpha/deploy-steps.md', 'work');
  fill(b, 19);
  const m = model({ 'agents/codex-alpha/deploys.md': 'work' });
  const out = await pass(b, m);
  assert.deepEqual(m.paths(), [['agents/example-agent/family.md']]);
  assert.equal(b.text('agents/codex-alpha/deploys.md'), apiNote('deploys', ...DEPLOYS));
  assert.equal(b.entry('agents/codex-alpha/deploys.md').domain, undefined);
  assert.ok(out.lines.includes('label agents/codex-alpha: nothing written'), out.lines.join('\n'));
  assert.ok(out.lines.includes("- agents/codex-alpha/deploys.md: not written; the scope's search entries would take more than the 240000 bytes the memory API allows"), out.lines.join('\n'));
  // It stays touched: it has no record entry, and every run checks it again without sending it.
  assert.equal(Object.hasOwn(b.scope('codex-alpha').labels, 'deploys.md'), false);
  const again = model();
  await pass(b, again);
  assert.deepEqual(again.calls, []);
  // With 20 bytes of room every label fits: it is sent, and `personal` takes the scope to the limit exactly.
  const c = bucket();
  c.labelEntry('agents/codex-alpha/deploy-steps.md', 'work');
  fill(c, 20);
  const n = model({ 'agents/codex-alpha/deploys.md': 'personal' });
  await pass(c, n);
  assert.deepEqual(n.paths(), [['agents/codex-alpha/deploys.md'], ['agents/example-agent/family.md']]);
  assert.equal(c.text('agents/codex-alpha/deploys.md'), labeled('deploys', ...DEPLOYS, 'personal'));
  assert.equal(scopeBytes(c), 240_000);

  // A note whose text after the frontmatter is over the API's 50,000 bytes is never sent either.
  const d = bucket({ 'example-agent': { huge: ['A long note', 'h'.repeat(50_001), null] } });
  const dm = model();
  const res = await pass(d, dm);
  assert.deepEqual(dm.calls, []);
  assert.equal(d.text('agents/example-agent/huge.md'), apiNote('huge', 'A long note', 'h'.repeat(50_001)));
  assert.ok(res.lines.includes('- agents/example-agent/huge.md: not written; its text after the frontmatter is over the 50000 bytes the memory API allows'), res.lines.join('\n'));
  assert.deepEqual(d.scope('example-agent').labels, {});
});

test('a label written at the limit of the scope is checked again before it is written', async () => {
  // Two touched notes, each alone within the limit: the first label written takes the room of the second.
  const b = bucket({ 'codex-alpha': { deploys: [...DEPLOYS, null], 'deploy-steps': [...STEPS, null] } });
  fill(b, 35);
  await pass(b, model({ 'agents/codex-alpha/deploy-steps.md': 'personal', 'agents/codex-alpha/deploys.md': 'personal' }));
  assert.equal(b.text('agents/codex-alpha/deploy-steps.md'), labeled('deploy-steps', ...STEPS, 'personal'));
  assert.equal(b.text('agents/codex-alpha/deploys.md'), apiNote('deploys', ...DEPLOYS));
  assert.ok(scopeBytes(b) <= 240_000);
  assert.deepEqual(Object.keys(b.scope('codex-alpha').labels).filter((file) => !file.startsWith('filler-')), ['deploy-steps.md']);
});

test("a note whose frontmatter the pass cannot edit is left for Organize's repair", async () => {
  const b = bucket({ 'example-agent': { family: [...FAMILY, null] } });
  b.put('agents/example-agent/plain.md', 'Just a line, no frontmatter.\n');
  b.fake.objects.set('agents/example-agent/latin.md', { body: Buffer.concat([Buffer.from(apiNote('latin', 'Latin', 'Caf').trimEnd()), Buffer.from([0xe9, 0x0a])]), etag: '"latin"' });
  const m = model();
  const out = await pass(b, m);
  assert.deepEqual(m.paths(), [['agents/example-agent/family.md']]);
  assert.equal(b.text('agents/example-agent/plain.md'), 'Just a line, no frontmatter.\n');
  assert.deepEqual(Object.keys(b.scope('example-agent').labels), ['family.md']);
  assert.match(out.lines.join('\n'), /^Left for Organize's repair:\n- agents\/example-agent\/latin\.md: not UTF-8 text\n- agents\/example-agent\/plain\.md: no frontmatter$/m);
  // They are listed on every run until they are repaired, and never sent.
  const again = await pass(b, m);
  assert.equal(m.calls.length, 1);
  assert.match(again.lines.join('\n'), /^Left for Organize's repair:\n- agents\/example-agent\/latin\.md/m);
});

test('a token that cannot be made leaves every note to the next run', async () => {
  const b = bucket();
  const exceptions = { 'agents/codex-alpha/deploys.md': 'work' };
  const m = model();
  const token = async () => { throw new Error('the label token file is not a token'); };
  const out = await pass(b, m, { token, domains: domainsOf({ exceptions }) });
  assert.equal(out.failed, true);
  assert.deepEqual(m.calls, []);
  assert.equal(out.lines[0], 'label: the label token could not be made (the label token file is not a token); no note was sent to the model.');
  assert.ok(out.lines.includes('- agents/example-agent/family.md: not sent; the label token could not be made'), out.lines.join('\n'));
  // The exception and the labels found are written and recorded all the same.
  assert.equal(b.text('agents/codex-alpha/deploys.md'), labeled('deploys', ...DEPLOYS, 'work'));
  assert.deepEqual(Object.keys(b.scope('codex-alpha').labels), ['deploy-steps.md', 'deploys.md']);
  assert.deepEqual(b.scope('example-agent').labels, {});
});

test('a signal during the model calls writes nothing', async () => {
  const b = bucket();
  const abort = new AbortController();
  const m = model({}, { onCall: () => abort.abort() });
  const out = await pass(b, m, { signal: abort.signal });
  assert.equal(m.calls.length, 1);
  assert.deepEqual(b.writes(), []);
  // The run says it was interrupted; the pass adds nothing to that.
  assert.deepEqual(out, { failed: false, lines: [] });
  assert.equal(b.text(STATE_KEY), undefined);
});

test('the pass covers the named scopes only, and says when the bucket cannot be read', async () => {
  const b = bucket();
  const m = model();
  const out = await pass(b, m, { opts: { agentNames: ['example-agent'] } });
  assert.deepEqual(m.paths(), [['agents/example-agent/family.md']]);
  assert.equal(b.scope('codex-alpha'), undefined);
  assert.deepEqual(out.lines.filter((l) => l.startsWith('label agents/')), ['label agents/example-agent: applied, 1 label(s) written, 0 unchanged']);
  b.fake.failNext(3, 503);
  const down = await pass(b, m);
  assert.equal(down.failed, true);
  assert.deepEqual(down.lines, ['label: the agent scopes could not be read (list failed: 503 ServiceUnavailable); no label was written.']);
});

// ---- Failure paths ----

test('a note write that fails leaves the scope\'s other labels for the next run and fails the pass', async () => {
  const b = bucket({ 'codex-alpha': { deploys: [...DEPLOYS, null], steps: [...STEPS, null] }, 'example-agent': { family: [...FAMILY, null] } });
  failOn(b, 'PUT', 'agents/codex-alpha/deploys.md');
  const out = await pass(b, model());
  assert.equal(out.failed, true);
  // After the failed write no other note of the scope is written.
  assert.deepEqual(b.writes().filter((r) => r.key.startsWith('agents/codex-alpha/')).map((r) => r.key), Array(3).fill('agents/codex-alpha/deploys.md'));
  assert.equal(b.text('agents/codex-alpha/steps.md'), apiNote('steps', ...STEPS));
  for (const line of [
    'label agents/codex-alpha: no-change, 0 label(s) written, 0 unchanged, 2 not written',
    '  - a write to the bucket failed (put failed: 503 ServiceUnavailable); the scope\'s other labels are left for the next run',
    '- agents/codex-alpha/deploys.md: not written; a write to the bucket failed',
    '- agents/codex-alpha/steps.md: not written; a write to the bucket failed',
  ]) assert.ok(out.lines.includes(line), out.lines.join('\n'));
  // Neither is recorded: the next run sends both again. The next scope is written.
  assert.deepEqual(b.scope('codex-alpha').labels, {});
  assert.equal(b.text('agents/example-agent/family.md'), labeled('family', ...FAMILY, 'general'));
  const next = model();
  await pass(b, next);
  assert.deepEqual(next.paths(), [['agents/codex-alpha/deploys.md', 'agents/codex-alpha/steps.md']]);
});

test('a failed update of the search entries leaves the scope due for Organize and fails the pass', async () => {
  const b = bucket();
  const organized = await b.digest('codex-alpha');
  b.setState({ 'codex-alpha': { organizedDigest: organized } });
  failOn(b, 'PUT', SNAPSHOT_KEY);
  const out = await pass(b, model({ 'agents/codex-alpha/deploys.md': 'work' }));
  assert.equal(out.failed, true);
  assert.ok(out.lines.includes('  - the search entries of the scope could not be updated (put failed: 503 ServiceUnavailable);'
    + ' it stays due for Organize, which rewrites them'), out.lines.join('\n'));
  // The label is written and recorded, its entry is not updated, and Organize's record does not move.
  assert.equal(b.text('agents/codex-alpha/deploys.md'), labeled('deploys', ...DEPLOYS, 'work'));
  assert.equal(b.entry('agents/codex-alpha/deploys.md').domain, undefined);
  assert.deepEqual(b.scope('codex-alpha').labels, {
    'deploy-steps.md': b.etag('agents/codex-alpha/deploy-steps.md'), 'deploys.md': b.etag('agents/codex-alpha/deploys.md'),
  });
  assert.equal(b.scope('codex-alpha').organizedDigest, organized);
  assert.notEqual(await b.digest('codex-alpha'), organized, 'Organize finds the scope due');
  // The next scope is written and recorded.
  assert.equal(b.entry('agents/example-agent/family.md').domain, 'general');
});

test('a record that cannot be written fails the pass; the labels stay', async () => {
  const b = bucket();
  failOn(b, 'PUT', STATE_KEY);
  const out = await pass(b, model({ 'agents/codex-alpha/deploys.md': 'work' }));
  assert.equal(out.failed, true);
  assert.ok(out.lines.includes('  - the run could not be recorded in index/organizer.json: put failed: 503 ServiceUnavailable'), out.lines.join('\n'));
  assert.equal(b.text('agents/codex-alpha/deploys.md'), labeled('deploys', ...DEPLOYS, 'work'));
  assert.equal(b.scope('codex-alpha'), undefined);
  assert.deepEqual(Object.keys(b.scope('example-agent').labels), ['family.md']);
  // The scope's next run is a first run: it records the labels it finds and sends nothing.
  const next = model();
  const again = await pass(b, next);
  assert.equal(again.failed, false, again.lines.join('\n'));
  assert.deepEqual(next.calls, []);
  assert.deepEqual(Object.keys(b.scope('codex-alpha').labels), ['deploy-steps.md', 'deploys.md']);
});

test('a note larger than the memory API can have written is not read', async () => {
  const b = bucket({ 'example-agent': { family: [...FAMILY, null] } });
  b.put('agents/example-agent/huge.md', apiNote('huge', 'Huge', 'h'.repeat(1_000_000)));
  const m = model();
  const out = await pass(b, m);
  assert.deepEqual(reads(b, 0), ['agents/example-agent/family.md']);
  assert.deepEqual(m.paths(), [['agents/example-agent/family.md']]);
  assert.ok(out.lines.includes('- agents/example-agent/huge.md: not read; larger than 1000000 bytes'), out.lines.join('\n'));
  assert.deepEqual(Object.keys(b.scope('example-agent').labels), ['family.md']);
  // A note that grows past the limit between the listing and its read is not taken either.
  const c = bucket({ 'example-agent': { family: [...FAMILY, null] } });
  c.fake.onRequest(({ method, key }) => {
    if (method === 'GET' && key === 'agents/example-agent/family.md') c.put(key, apiNote('family', FAMILY[0], 'f'.repeat(1_000_000)));
  });
  const n = model();
  const res = await pass(c, n);
  assert.deepEqual(n.calls, []);
  assert.ok(res.lines.includes('- agents/example-agent/family.md: not read; larger than 1000000 bytes'), res.lines.join('\n'));
  assert.deepEqual(c.scope('example-agent').labels, {});
});

test('the search entries of the notes read get their note\'s label in the same update', async () => {
  // A first run: the labeled note it finds gets its label in its entry, with the written note's.
  const b = bucket();
  let from = b.fake.requests.length;
  await pass(b, model({ 'agents/codex-alpha/deploys.md': 'work' }));
  assert.equal(b.entry('agents/codex-alpha/deploy-steps.md').domain, 'work');
  assert.equal(b.entry('agents/codex-alpha/deploys.md').domain, 'work');
  const snapshotPuts = (since) => b.fake.requests.slice(since).filter((r) => r.method === 'PUT' && r.key === SNAPSHOT_KEY).length;
  assert.equal(snapshotPuts(from), 2, 'one update per scope');
  // An older kit's Organize rewrites the entries without labels. The next run reads the recorded
  // notes again, sends none of them, and gives their entries the labels back.
  b.stripLabels();
  const m = model();
  from = b.fake.requests.length;
  const out = await pass(b, m);
  assert.equal(out.failed, false, out.lines.join('\n'));
  assert.deepEqual(m.calls, []);
  assert.deepEqual(reads(b, from), ['agents/codex-alpha/deploy-steps.md', 'agents/codex-alpha/deploys.md', 'agents/example-agent/family.md']);
  assert.deepEqual(['codex-alpha/deploy-steps', 'codex-alpha/deploys', 'example-agent/family'].map((n) => b.entry(`agents/${n}.md`).domain), ['work', 'work', 'general']);
  assert.equal(snapshotPuts(from), 2);
  // Then nothing is read again.
  from = b.fake.requests.length;
  await pass(b, m);
  assert.deepEqual(reads(b, from), []);
  assert.equal(snapshotPuts(from), 0);
  // A note whose label holds under --all, or under its exception, gets it in its entry too.
  b.stripLabels();
  const exceptions = { 'agents/example-agent/family.md': 'general' };
  await pass(b, model({ 'agents/codex-alpha/deploys.md': 'work', 'agents/codex-alpha/deploy-steps.md': 'work' }), { opts: { all: true }, domains: domainsOf({ exceptions }) });
  assert.deepEqual(['codex-alpha/deploy-steps', 'codex-alpha/deploys', 'example-agent/family'].map((n) => b.entry(`agents/${n}.md`).domain), ['work', 'work', 'general']);
  // A dry run writes no entry.
  b.stripLabels();
  const before = b.text(SNAPSHOT_KEY);
  await pass(b, model(), { opts: { dryRun: true } });
  assert.equal(b.text(SNAPSHOT_KEY), before);
});

test('an entry that would take its scope past the limit keeps what it has', async () => {
  // `domain: work` adds 16 bytes to the entry of the labeled note: with 15 bytes of room it stays without.
  const b = bucket({ 'codex-alpha': { 'deploy-steps': [...STEPS, 'work'] } });
  fill(b, 15);
  const out = await pass(b, model());
  assert.equal(out.failed, false, out.lines.join('\n'));
  assert.equal(b.entry('agents/codex-alpha/deploy-steps.md').domain, undefined);
  assert.equal(scopeBytes(b), 240_000 - 15);
  // With 16 bytes it gets the label, to the limit exactly.
  const c = bucket({ 'codex-alpha': { 'deploy-steps': [...STEPS, 'work'] } });
  fill(c, 16);
  await pass(c, model());
  assert.equal(c.entry('agents/codex-alpha/deploy-steps.md').domain, 'work');
  assert.equal(scopeBytes(c), 240_000);
});

test('a run over every agent scope names the exceptions of scopes it did not find', async () => {
  const exceptions = { 'agents/nobody/x.md': 'work', 'agents/codex-alpha/gone.md': 'general', 'projects/example-project/y.md': 'work' };
  const b = bucket();
  const out = await pass(b, model(), { domains: domainsOf({ exceptions }) });
  const text = out.lines.join('\n');
  assert.match(text, /^Exceptions that name no note:\n- agents\/codex-alpha\/gone\.md$/m);
  assert.match(text, /\n\n## agents\/nobody\n\nExceptions that name no note:\n- agents\/nobody\/x\.md$/);
  assert.doesNotMatch(text, /example-project/);
  // A run that names its scopes names only theirs.
  const named = await pass(b, model(), { domains: domainsOf({ exceptions }), opts: { agentNames: ['codex-alpha'] } });
  assert.doesNotMatch(named.lines.join('\n'), /nobody/);
  // A bucket without agent scopes says so, and still names them.
  const empty = createFakeS3();
  const client = createS3({ bucket: 'example-bucket', region: 'ap-northeast-1', credentials, fetchImpl: empty.fetch, sleep: async () => {} });
  const none = await pass({ s3: async () => client }, model(), { domains: domainsOf({ exceptions }) });
  assert.deepEqual(none, { failed: false, lines: ['label: nothing to do', '## agents/codex-alpha', '', 'Exceptions that name no note:', '- agents/codex-alpha/gone.md', '', '## agents/nobody', '', 'Exceptions that name no note:', '- agents/nobody/x.md'] });
});

test('a search snapshot that cannot be read, before or after the model calls, writes no label', async () => {
  const b = bucket();
  failOn(b, 'GET', SNAPSHOT_KEY, 1);
  const m = model();
  const first = await pass(b, m);
  assert.deepEqual(first, { failed: true, lines: ['label: the agent scopes could not be read (get failed: 503 ServiceUnavailable); no label was written.'] });
  assert.deepEqual(m.calls, []);
  // Read again right before the writes, for their limits.
  const c = bucket();
  failOn(c, 'GET', SNAPSHOT_KEY, 2);
  const n = model();
  const second = await pass(c, n);
  assert.equal(second.failed, true);
  assert.equal(n.calls.length, 2);
  assert.equal(second.lines.at(-1), 'label: the search entries of the agent scopes could not be read (get failed: 503 ServiceUnavailable); no label was written.');
  assert.deepEqual(c.writes(), []);
});

test('when no S3 client can be made for the writes, the line says what was not done', async () => {
  // Labeled notes whose entries lack their labels: there are entries to update, and no note to write.
  const b = bucket({ 'codex-alpha': { 'deploy-steps': [...STEPS, 'work'] } });
  let made = 0;
  const s3For = async () => {
    made += 1;
    if (made > 2) throw new AwsError('sts', 0, 'Network');
    return b.client;
  };
  const out = await pass(b, model(), { s3For });
  assert.equal(out.failed, true);
  assert.ok(out.lines.includes('  - the search entries of the scope could not be updated and the run could not be recorded in index/organizer.json: sts failed: 0 Network'), out.lines.join('\n'));
  assert.deepEqual(b.writes(), []);
  // With no entry to update, only the record is named.
  b.labelEntry('agents/codex-alpha/deploy-steps.md', 'work');
  made = 0;
  const again = await pass(b, model(), { s3For });
  assert.ok(again.lines.includes('  - the run could not be recorded in index/organizer.json: sts failed: 0 Network'), again.lines.join('\n'));
});
