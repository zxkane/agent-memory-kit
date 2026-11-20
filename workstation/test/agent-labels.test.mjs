import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { labelAgentScopes } from '../lib/agent-labels.mjs';
import { SNAPSHOT_KEY, STATE_KEY, listAgentScopes, scopeDigest } from '../lib/agent-scopes.mjs';
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

function pass(b, m, { opts = {}, domains = domainsOf(), token = tokens().token, signal, config = CONFIG } = {}) {
  return labelAgentScopes({
    config, opts: { agentNames: [], all: false, dryRun: false, ...opts }, s3: b.s3, started: STARTED,
    domains, persona: 'The owner is an example tester.', token, labelBatch: m.labelBatch, signal,
  });
}

const reads = (b, from) => b.fake.requests.slice(from).filter((r) => r.method === 'GET' && r.key.startsWith('agents/')).map((r) => r.key);

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
// search entries of codex-alpha to `240000 - room` bytes. Each is labeled already, so a first run
// only confirms it.
function fill(b, room) {
  const BASE = 47_500;
  const filler = (i, size) => [`filler-${i}`, `Filler ${i}`, 'f'.repeat(size)];
  const write = ([name, description, content]) => {
    b.agentWrites('codex-alpha', name, description, content);
    b.put(`agents/codex-alpha/${name}.md`, labeled(name, description, content, 'general'));
  };
  for (let i = 1; i <= 5; i++) write(filler(i, BASE));
  const entries = () => JSON.parse(b.text(SNAPSHOT_KEY)).notes.filter((n) => n.path.startsWith('agents/codex-alpha/'));
  const size = BASE + 240_000 - room - Buffer.byteLength(JSON.stringify(entries()));
  assert.ok(size > BASE && size <= 50_000, `filler size ${size}`);
  write(filler(5, size));
  assert.equal(Buffer.byteLength(JSON.stringify(entries())), 240_000 - room);
}

test("a label that would take a scope past the memory API's limits is not written", async () => {
  // A `domain` field of `work` adds 16 bytes to the entry: with 15 bytes of room it does not fit.
  const b = bucket();
  fill(b, 15);
  const out = await pass(b, model({ 'agents/codex-alpha/deploys.md': 'work' }));
  assert.equal(b.text('agents/codex-alpha/deploys.md'), apiNote('deploys', ...DEPLOYS));
  assert.equal(b.entry('agents/codex-alpha/deploys.md').domain, undefined);
  assert.ok(out.lines.includes('label agents/codex-alpha: no-change, 0 label(s) written, 0 unchanged, 1 not written'), out.lines.join('\n'));
  assert.ok(out.lines.includes("- agents/codex-alpha/deploys.md: not written; the scope's search entries would take more than the 240000 bytes the memory API allows"), out.lines.join('\n'));
  // The note stays touched: it has no record entry and goes to the model again.
  assert.equal(Object.hasOwn(b.scope('codex-alpha').labels, 'deploys.md'), false);
  const again = model({ 'agents/codex-alpha/deploys.md': 'work' });
  await pass(b, again);
  assert.deepEqual(again.paths(), [['agents/codex-alpha/deploys.md']]);
  // With 16 bytes of room it fits exactly.
  const c = bucket();
  fill(c, 16);
  await pass(c, model({ 'agents/codex-alpha/deploys.md': 'work' }));
  assert.equal(c.text('agents/codex-alpha/deploys.md'), labeled('deploys', ...DEPLOYS, 'work'));
  assert.equal(Buffer.byteLength(JSON.stringify(JSON.parse(c.text(SNAPSHOT_KEY)).notes.filter((n) => n.path.startsWith('agents/codex-alpha/')))), 240_000);

  // A note whose text after the frontmatter is over the API's 50,000 bytes is not written either.
  const d = bucket({ 'example-agent': { huge: ['A long note', 'h'.repeat(50_001), null] } });
  const res = await pass(d, model());
  assert.equal(d.text('agents/example-agent/huge.md'), apiNote('huge', 'A long note', 'h'.repeat(50_001)));
  assert.ok(res.lines.includes('- agents/example-agent/huge.md: not written; its text after the frontmatter is over the 50000 bytes the memory API allows'), res.lines.join('\n'));
  assert.deepEqual(d.scope('example-agent').labels, {});
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
