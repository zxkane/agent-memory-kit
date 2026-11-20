import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SNAPSHOT_KEY, STATE_KEY, agentScopeProblems, agentScopesS3, applyAgentScope, copyAgentScope, listAgentScopes,
  mergeIndex, noteEntry, readOrganizerState, readSearchEntries, recordOrganizerState, repairAgentEntries, scopeDigest,
  setNoteEntries,
} from '../lib/agent-scopes.mjs';
import { createS3 } from '../lib/s3.mjs';
import { evaluate, snapshot } from '../lib/workdir.mjs';
import { createFakeS3 } from './fake-s3.mjs';
import { tempDir } from './helpers.mjs';

const credentials = { accessKeyId: 'EXAMPLEKEYID', secretAccessKey: 'example-signing-value', sessionToken: 'example-session-value' };
const md5 = (body) => `"${createHash('md5').update(body).digest('hex')}"`;

// A note file as the memory API composes it (api/src/note-file.ts).
const apiNote = (name, description, content, type = 'reference') =>
  ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`, 'metadata:', `  type: ${type}`, '---', '', content].join('\n') + '\n';
const indexLine = (name, description) => `- [${name}](${name}.md) — ${description}`;

// Enough distinct words (22) for the content retention check to judge a note on its own.
const FACTS = 'Deploys always go through the staging stack first; staging listens on port 8443, production answers on port 443 behind the shared load balancer, and every release needs a signed changelog entry before promotion.';

// A bucket with the agent scope `codex-alpha` (two notes that say the same thing), another agent's
// scope, and the search snapshot listing all of them plus an entry that is not a note.
function bucket() {
  const fake = createFakeS3();
  const s3 = createS3({ bucket: 'example-bucket', region: 'ap-northeast-1', credentials, fetchImpl: fake.fetch, sleep: async () => {} });
  const put = (key, text) => fake.objects.set(key, { body: Buffer.from(text), etag: md5(text) });
  const notes = [
    ['codex-alpha', 'deploys', 'How deploys go', FACTS],
    ['codex-alpha', 'deploy-steps', 'Deploy steps', FACTS],
    ['claude-beta', 'other', 'Another agent', 'An unrelated fact of another agent.'],
  ];
  const entries = [];
  for (const [agent, name, description, content] of notes) {
    put(`agents/${agent}/${name}.md`, apiNote(name, description, content));
    entries.push({ path: `agents/${agent}/${name}.md`, name, description, type: 'reference', body: content });
  }
  put('agents/codex-alpha/MEMORY.md', `${indexLine('deploys', 'How deploys go')}\n${indexLine('deploy-steps', 'Deploy steps')}\n`);
  put('agents/claude-beta/MEMORY.md', `${indexLine('other', 'Another agent')}\n`);
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  put(SNAPSHOT_KEY, JSON.stringify({ version: 1, extra: 'kept', notes: [...entries, { odd: true }] }));
  const text = (key) => fake.objects.get(key)?.body.toString('utf8');
  return { fake, s3, put, text, snapshot: () => JSON.parse(text(SNAPSHOT_KEY)) };
}

// Copies the scope, lets `edit` change the work copy as a model would, and evaluates the result.
async function organizeRun(t, b, edit, agent = 'codex-alpha') {
  const root = tempDir(t);
  const liveDir = join(root, 'live');
  const workDir = join(root, 'work', 'notes');
  mkdirSync(liveDir);
  const plan = await copyAgentScope({ s3: b.s3, agent, dir: liveDir });
  const pairs = [{ label: 'notes', liveDir, workDir }];
  const snap = snapshot(pairs);
  edit((file, text) => writeFileSync(join(workDir, file), text));
  const ev = evaluate({ pairs, snap, allowRetire: true });
  return { plan, ev, liveDir, workDir, problems: agentScopeProblems({ agent, plan, changes: ev.changes, liveDir, workDir }) };
}

const MERGED = apiNote('deploys', 'How deploys go (merged)', `${FACTS} Steps: build, deploy to staging, check, promote.`);
const mergeEdit = (write) => {
  write('deploys.md', MERGED);
  write('deploy-steps.md', 'MOVED TO [[deploys]]\n');
  write('MEMORY.md', `${indexLine('deploys', 'How deploys go, with the steps')}\n`);
};

test('the scopes are the keys agents/<agent>/<file>.md; anything else under agents/ is left out', async () => {
  const b = bucket();
  for (const key of ['agents/codex-alpha/sub/x.md', 'agents/Upper/x.md', 'agents/codex-alpha/x.txt', 'agents/x.md', 'agents/codex-alpha/.hidden.md']) b.put(key, 'x');
  const scopes = await listAgentScopes(b.s3);
  assert.deepEqual([...scopes.keys()].sort(), ['claude-beta', 'codex-alpha']);
  assert.deepEqual(scopes.get('codex-alpha').map((f) => f.file), ['MEMORY.md', 'deploy-steps.md', 'deploys.md']);
  const digest = scopeDigest(scopes.get('codex-alpha'));
  b.put('agents/codex-alpha/deploys.md', 'changed');
  assert.notEqual(scopeDigest((await listAgentScopes(b.s3)).get('codex-alpha')), digest);
});

test('a copy holds the scope\'s notes and its own snapshot entries only', async (t) => {
  const b = bucket();
  const dir = tempDir(t);
  const plan = await copyAgentScope({ s3: b.s3, agent: 'codex-alpha', dir });
  assert.equal(readFileSync(join(dir, 'deploys.md'), 'utf8'), b.text('agents/codex-alpha/deploys.md'));
  assert.deepEqual(Object.keys(plan.etags).sort(), ['MEMORY.md', 'deploy-steps.md', 'deploys.md']);
  assert.deepEqual(plan.entries.map((e) => e.path), ['agents/codex-alpha/deploy-steps.md', 'agents/codex-alpha/deploys.md']);
  assert.equal(plan.snapshotBytes, Buffer.byteLength(b.text(SNAPSHOT_KEY)));
  await assert.rejects(copyAgentScope({ s3: b.s3, agent: '../x', dir }), /invalid agent name/);
});

test('a note entry is what the memory API writes for the same file', () => {
  const entry = noteEntry('codex-alpha', 'deploys.md', apiNote('deploys', 'Say "hi" — and more', 'Line one.\n\nLine two.\n\n'));
  assert.deepEqual(entry, {
    path: 'agents/codex-alpha/deploys.md', name: 'deploys', description: 'Say "hi" — and more', type: 'reference', body: 'Line one.\n\nLine two.',
  });
});

// A note as apiNote composes it, with `line` added to its metadata block.
const withLine = (text, line) => text.replace('  type: reference\n', `  type: reference\n${line}\n`);

test('noteEntry carries a valid domain only', () => {
  const text = apiNote('deploys', 'How deploys go', 'Deploys go through staging.');
  const plain = noteEntry('codex-alpha', 'deploys.md', text);
  assert.equal(Object.hasOwn(plain, 'domain'), false);
  for (const [line, domain] of [['  domain: work', 'work'], ['  domain: "personal"', 'personal'], ["  domain: 'general'", 'general']]) {
    assert.deepEqual(noteEntry('codex-alpha', 'deploys.md', withLine(text, line)), { ...plain, domain }, line);
  }
  // A value that is not a label, or a domain outside metadata:, gives none.
  for (const other of [withLine(text, '  domain: home'), withLine(text, '  domain:'), text.replace('metadata:\n', 'domain: work\nmetadata:\n')]) {
    assert.equal(Object.hasOwn(noteEntry('codex-alpha', 'deploys.md', other), 'domain'), false, other);
  }
});

test('the search entries keep the labels of every scope when one of them is organized', async (t) => {
  const b = bucket();
  // Labeled notes, whose entries carry their labels as the label step leaves them.
  const labeledNote = (name, description, content, label) => withLine(apiNote(name, description, content), `  domain: ${label}`);
  b.put('agents/claude-beta/other.md', labeledNote('other', 'Another agent', 'An unrelated fact of another agent.', 'personal'));
  b.put('agents/codex-alpha/deploys.md', labeledNote('deploys', 'How deploys go', FACTS, 'work'));
  const doc = b.snapshot();
  doc.notes.find((n) => n.path === 'agents/claude-beta/other.md').domain = 'personal';
  doc.notes.find((n) => n.path === 'agents/codex-alpha/deploys.md').domain = 'work';
  b.put(SNAPSHOT_KEY, JSON.stringify(doc));
  assert.deepEqual((await readSearchEntries(b.s3)).filter((e) => e.domain).map((e) => [e.path, e.domain]), [
    ['agents/claude-beta/other.md', 'personal'], ['agents/codex-alpha/deploys.md', 'work'],
  ]);
  // Entries that carry the notes' labels are in step with them.
  const run = await organizeRun(t, b, (w) => {
    w('deploys.md', labeledNote('deploys', 'How deploys go (merged)', `${FACTS} Steps: build, deploy to staging, check, promote.`, 'work'));
    w('deploy-steps.md', 'MOVED TO [[deploys]]\n');
    w('MEMORY.md', `${indexLine('deploys', 'How deploys go, with the steps')}\n`);
  });
  assert.equal(run.plan.inStep, true);
  assert.deepEqual(run.problems, []);
  const res = await applyAgentScope({ s3: b.s3, agent: 'codex-alpha', plan: run.plan, changes: run.ev.changes, liveDir: run.liveDir, workDir: run.workDir });
  assert.equal(res.outcome, 'applied');
  // The organized scope's entry takes its label from the note; another scope's entry keeps its own.
  const after = b.snapshot().notes;
  assert.equal(after.find((n) => n.path === 'agents/codex-alpha/deploys.md').domain, 'work');
  assert.equal(after.find((n) => n.path === 'agents/claude-beta/other.md').domain, 'personal');
  // A value that is not a label is not kept.
  const odd = b.snapshot();
  odd.notes.find((n) => n.path === 'agents/claude-beta/other.md').domain = 'home';
  b.put(SNAPSHOT_KEY, JSON.stringify(odd));
  assert.equal(Object.hasOwn((await readSearchEntries(b.s3)).find((e) => e.path === 'agents/claude-beta/other.md'), 'domain'), false);
});

test('setNoteEntries replaces the entries of the notes it is given, in one conditional update', async () => {
  const b = bucket();
  const label = (text, domain) => withLine(text, `  domain: ${domain}`);
  const deploys = label(apiNote('deploys', 'How deploys go', FACTS), 'work');
  const steps = label(apiNote('deploy-steps', 'Deploy steps', FACTS), 'personal');
  // An agent is writing deploy-steps through the API: its entry already holds the new text.
  const doc = b.snapshot();
  doc.notes.find((n) => n.path === 'agents/codex-alpha/deploy-steps.md').body = 'An agent is writing this note right now.';
  // An entry that is missing is added.
  doc.notes = doc.notes.filter((n) => n.path !== 'agents/codex-alpha/deploys.md');
  b.put(SNAPSHOT_KEY, JSON.stringify(doc));
  const before = b.snapshot();
  await setNoteEntries(b.s3, 'codex-alpha', [{ file: 'deploys.md', text: deploys }, { file: 'deploy-steps.md', text: steps }]);
  const after = b.snapshot();
  assert.deepEqual(after.notes.find((n) => n.path === 'agents/codex-alpha/deploys.md'), noteEntry('codex-alpha', 'deploys.md', deploys));
  assert.equal(after.notes.find((n) => n.path === 'agents/codex-alpha/deploys.md').domain, 'work');
  // The agent's write wins: an entry that no longer describes the labeled note stays as it is.
  assert.deepEqual(after.notes.find((n) => n.path === 'agents/codex-alpha/deploy-steps.md'), before.notes.find((n) => n.path === 'agents/codex-alpha/deploy-steps.md'));
  // Everything else is kept: other scopes, entries that are not notes, other keys; notes stay sorted.
  assert.deepEqual(after.notes.find((n) => n.path === 'agents/claude-beta/other.md'), before.notes.find((n) => n.path === 'agents/claude-beta/other.md'));
  assert.deepEqual(after.notes.map((n) => n.path ?? 'odd'), ['agents/claude-beta/other.md', 'agents/codex-alpha/deploy-steps.md', 'agents/codex-alpha/deploys.md', 'odd']);
  assert.equal(after.extra, 'kept');
  const puts = b.fake.requests.filter((r) => r.method === 'PUT' && r.key === SNAPSHOT_KEY);
  assert.equal(puts.length, 1);
  assert.ok(puts[0].headers['if-match']);
  // An entry the run left as the API wrote it, apart from the label, is replaced.
  await setNoteEntries(b.s3, 'claude-beta', [{ file: 'other.md', text: label(apiNote('other', 'Another agent', 'An unrelated fact of another agent.'), 'general') }]);
  assert.equal(b.snapshot().notes.find((n) => n.path === 'agents/claude-beta/other.md').domain, 'general');
  await assert.rejects(setNoteEntries(b.s3, '../x', [{ file: 'a.md', text: deploys }]), /invalid agent name/);
  await assert.rejects(setNoteEntries(b.s3, 'codex-alpha', [{ file: 'MEMORY.md', text: deploys }]), /not a note/);
});

test('TC-AGENT-ORG-001: two duplicate notes are merged; the retired one is gone from the bucket, MEMORY.md and the snapshot', async (t) => {
  const b = bucket();
  const run = await organizeRun(t, b, mergeEdit);
  assert.deepEqual(run.ev.errors, []);
  assert.deepEqual(run.problems, []);
  const before = b.snapshot();
  const res = await applyAgentScope({ s3: b.s3, agent: 'codex-alpha', plan: run.plan, changes: run.ev.changes, liveDir: run.liveDir, workDir: run.workDir });
  assert.deepEqual({ ...res, digest: undefined }, { outcome: 'applied', written: 2, deleted: 1, keptNewer: [], kept: [], digest: undefined });
  // The digest is the scope as the run left it: what a listing now shows.
  assert.equal(res.digest, scopeDigest((await listAgentScopes(b.s3)).get('codex-alpha')));
  assert.equal(b.fake.objects.has('agents/codex-alpha/deploy-steps.md'), false);
  assert.equal(b.text('agents/codex-alpha/deploys.md'), MERGED);
  assert.equal(b.text('agents/codex-alpha/MEMORY.md'), `${indexLine('deploys', 'How deploys go, with the steps')}\n`);
  const after = b.snapshot();
  assert.deepEqual(after.notes.map((n) => n.path ?? 'odd'), ['agents/claude-beta/other.md', 'agents/codex-alpha/deploys.md', 'odd']);
  assert.equal(after.notes[1].description, 'How deploys go (merged)');
  assert.match(after.notes[1].body, /Steps: build/);
  assert.deepEqual(after.notes[0], before.notes[0], 'another agent\'s entry is untouched');
  assert.equal(after.extra, 'kept');
  // Every write was conditional: on the version read, or on the key being absent.
  const writes = b.fake.requests.filter((x) => x.method === 'PUT' || x.method === 'DELETE');
  for (const r of writes) {
    assert.ok(r.headers['if-match'] !== undefined || r.headers['if-none-match'] === '*', `${r.method} ${r.key}`);
  }
  // The note the retired one went to was written before the retired one was deleted.
  const at = (method, key) => writes.findIndex((r) => r.method === method && r.key === key);
  assert.ok(at('PUT', 'agents/codex-alpha/deploys.md') < at('DELETE', 'agents/codex-alpha/deploy-steps.md'));
});

test('TC-AGENT-ORG-002: a result that drops content, holds a credential or retires into a missing target is rejected', async (t) => {
  const cases = [
    ['retention', (w) => {
      w('deploys.md', apiNote('deploys', 'How deploys go', 'Deploys exist.'));
      w('deploy-steps.md', 'MOVED TO [[deploys]]\n');
      w('MEMORY.md', `${indexLine('deploys', 'How deploys go')}\n`);
    }, /most of this note's content is missing/],
    ['credential', (w) => w('deploys.md', apiNote('deploys', 'How deploys go', `${FACTS} The key is ${'AKIA'}${'ABCDEFGHIJKLMNOP'}.`)), /looks like a credential/],
    ['missing target', (w) => {
      w('deploy-steps.md', 'MOVED TO [[nowhere]]\n');
      w('MEMORY.md', `${indexLine('deploys', 'How deploys go')}\n`);
    }, /the target note does not exist/],
  ];
  for (const [label, edit, error] of cases) {
    const b = bucket();
    const objects = new Map(b.fake.objects);
    const run = await organizeRun(t, b, edit);
    assert.match(run.ev.errors.join('\n'), error, label);
    assert.deepEqual([...b.fake.objects.entries()], [...objects.entries()], `${label}: the bucket is unchanged`);
  }
});

test('TC-AGENT-ORG-002: a note the memory API could not have written is a problem', async (t) => {
  const b = bucket();
  const run = await organizeRun(t, b, (w) => {
    w('Bad_Name.md', apiNote('Bad_Name', 'A new note', 'Some fact about the build.'));
    w('memory.md', apiNote('memory', 'Reserved', 'Another fact.'));
    w('no-type.md', '---\nname: no-type\ndescription: A note\n---\n\nA fact.\n');
    w('two-lines.md', apiNote('two-lines', 'one\ntwo', 'A fact.'));
    w('empty.md', apiNote('empty', 'Nothing in it', ''));
    w('huge.md', apiNote('huge', 'Too long', 'x'.repeat(50_001)));
    w('MEMORY.md', `${indexLine('deploys', 'How deploys go')}\n${indexLine('deploy-steps', 'Deploy steps')}\n${['Bad_Name', 'memory', 'no-type', 'two-lines', 'empty', 'huge'].map((n) => indexLine(n, n)).join('\n')}\n`);
  });
  const text = run.problems.join('\n');
  assert.match(text, /notes\/Bad_Name\.md: a new note in an agent scope needs a file name/);
  assert.match(text, /notes\/memory\.md: a new note in an agent scope needs a file name/);
  assert.match(text, /notes\/no-type\.md: the frontmatter needs metadata\.type/);
  assert.match(text, /notes\/two-lines\.md: the frontmatter needs a description of one line/);
  assert.match(text, /notes\/empty\.md: the note text after the frontmatter must be 1 to 50000 bytes/);
  assert.match(text, /notes\/huge\.md: the note text after the frontmatter must be 1 to 50000 bytes/);
});

test('TC-AGENT-ORG-002: a result over the memory API\'s scope limits is a problem', async (t) => {
  const b = bucket();
  const run = await organizeRun(t, b, (w) => {
    const names = Array.from({ length: 200 }, (_, i) => `n${i}`);
    for (const n of names) w(`${n}.md`, apiNote(n, `Note ${n}`, `Fact number ${n} about the build.`));
    w('MEMORY.md', `${indexLine('deploys', 'a')}\n${indexLine('deploy-steps', 'b')}\n${names.map((n) => indexLine(n, n)).join('\n')}\n`);
  });
  assert.match(run.problems.join('\n'), /the scope would hold 202 notes; the memory API allows 200/);
});

test('TC-AGENT-ORG-003: a note written through the API after the copy stops the run; nothing of it is applied', async (t) => {
  for (const meanwhile of ['agents/codex-alpha/new-note.md', 'agents/codex-alpha/deploys.md', 'agents/codex-alpha/MEMORY.md']) {
    const b = bucket();
    const run = await organizeRun(t, b, mergeEdit);
    b.put(meanwhile, apiNote('x', 'written meanwhile', 'An agent wrote this meanwhile.'));
    const objects = new Map(b.fake.objects);
    const res = await applyAgentScope({ s3: b.s3, agent: 'codex-alpha', plan: run.plan, changes: run.ev.changes, liveDir: run.liveDir, workDir: run.workDir });
    assert.equal(res.outcome, 'changed-meanwhile', meanwhile);
    assert.deepEqual(res.liveChanged, [meanwhile.split('/').at(-1)]);
    assert.deepEqual([...b.fake.objects.entries()], [...objects.entries()], `${meanwhile}: nothing applied`);
  }
});

test('TC-AGENT-ORG-003: an entry the API changed in the snapshot after the copy stops the run before any write', async (t) => {
  const b = bucket();
  const run = await organizeRun(t, b, mergeEdit);
  // The API updates the snapshot first and the note after it: here only the first step happened.
  const doc = b.snapshot();
  doc.notes.find((n) => n.path === 'agents/codex-alpha/deploys.md').body = 'An agent is writing this note right now.';
  b.put(SNAPSHOT_KEY, JSON.stringify(doc));
  const objects = new Map(b.fake.objects);
  const res = await applyAgentScope({ s3: b.s3, agent: 'codex-alpha', plan: run.plan, changes: run.ev.changes, liveDir: run.liveDir, workDir: run.workDir });
  assert.deepEqual(res, { outcome: 'changed-meanwhile', liveChanged: ['index/agents.json'] });
  assert.deepEqual([...b.fake.objects.entries()], [...objects.entries()]);
});

test('TC-AGENT-ORG-003: a note an agent writes again while the run retires it is kept, with its entry and index line', async (t) => {
  const b = bucket();
  const run = await organizeRun(t, b, mergeEdit);
  const theirs = apiNote('deploy-steps', 'Deploy steps, rewritten', 'An agent rewrote the deploy steps just now.');
  // After the run has updated the snapshot and just before it deletes the note it retires, an
  // agent writes that note again, as the API does: snapshot entry, note, index line.
  let done = false;
  b.fake.onRequest(({ method, key }) => {
    if (!done && method === 'DELETE' && key === 'agents/codex-alpha/deploy-steps.md') {
      done = true;
      const doc = b.snapshot();
      doc.notes.push({ path: 'agents/codex-alpha/deploy-steps.md', name: 'deploy-steps', description: 'stale', type: 'reference', body: 'stale' });
      b.put(SNAPSHOT_KEY, JSON.stringify(doc));
      b.put('agents/codex-alpha/deploy-steps.md', theirs);
      b.put('agents/codex-alpha/MEMORY.md', b.text('agents/codex-alpha/MEMORY.md')
        .replace(indexLine('deploy-steps', 'Deploy steps'), indexLine('deploy-steps', 'Deploy steps, rewritten')));
    }
  });
  const res = await applyAgentScope({ s3: b.s3, agent: 'codex-alpha', plan: run.plan, changes: run.ev.changes, liveDir: run.liveDir, workDir: run.workDir });
  assert.deepEqual({ ...res, digest: undefined }, { outcome: 'applied', written: 2, deleted: 0, keptNewer: ['deploy-steps.md'], kept: [], digest: undefined });
  // The agent's version was never seen by the model: the scope stays due.
  assert.notEqual(res.digest, scopeDigest((await listAgentScopes(b.s3)).get('codex-alpha')));
  assert.equal(b.text('agents/codex-alpha/deploy-steps.md'), theirs, 'the agent\'s note is not lost');
  const entries = b.snapshot().notes.filter((n) => n.path === 'agents/codex-alpha/deploy-steps.md');
  assert.deepEqual(entries.map((e) => e.body), ['An agent rewrote the deploy steps just now.'], 'one entry, read back from the note');
  assert.equal(b.text('agents/codex-alpha/MEMORY.md'),
    `${indexLine('deploys', 'How deploys go, with the steps')}\n${indexLine('deploy-steps', 'Deploy steps, rewritten')}\n`);
});

// An agent's write through the API, as the API makes it: snapshot entry, note, index line.
function agentWrites(b, name, description, content) {
  const doc = b.snapshot();
  const path = `agents/codex-alpha/${name}.md`;
  doc.notes = [...doc.notes.filter((n) => n.path !== path), { path, name, description, type: 'reference', body: content }]
    .sort((x, y) => String(x.path ?? '~').localeCompare(String(y.path ?? '~')));
  b.put(SNAPSHOT_KEY, JSON.stringify(doc));
  b.put(path, apiNote(name, description, content));
  const lines = (b.text('agents/codex-alpha/MEMORY.md') ?? '').split('\n').filter(Boolean).filter((l) => !l.includes(`](${name}.md)`));
  b.put('agents/codex-alpha/MEMORY.md', `${[...lines, indexLine(name, description)].join('\n')}\n`);
}

test('a retired note is kept when an agent wrote the note it went to again, before this run could', async (t) => {
  const b = bucket();
  const run = await organizeRun(t, b, mergeEdit);
  let done = false;
  b.fake.onRequest(({ method, key }) => {
    if (!done && method === 'PUT' && key === 'agents/codex-alpha/deploys.md') {
      done = true;
      agentWrites(b, 'deploys', 'How deploys go, by an agent', 'An agent rewrote the deploys note just now.');
    }
  });
  const res = await applyAgentScope({ s3: b.s3, agent: 'codex-alpha', plan: run.plan, changes: run.ev.changes, liveDir: run.liveDir, workDir: run.workDir });
  assert.deepEqual({ ...res, digest: undefined }, { outcome: 'applied', written: 1, deleted: 0, keptNewer: ['deploys.md'], kept: ['deploy-steps.md'], digest: undefined });
  // Neither the agent's note nor the content of the note that was to be retired is lost.
  assert.match(b.text('agents/codex-alpha/deploys.md'), /An agent rewrote the deploys note just now\./);
  assert.match(b.text('agents/codex-alpha/deploy-steps.md'), /every release needs a signed changelog entry/);
  const entries = b.snapshot().notes.filter((n) => n.path?.startsWith('agents/codex-alpha/'));
  assert.deepEqual(entries.map((n) => [n.path, n.body.slice(0, 20)]), [
    ['agents/codex-alpha/deploy-steps.md', FACTS.slice(0, 20)],
    ['agents/codex-alpha/deploys.md', 'An agent rewrote the'],
  ]);
  assert.equal(b.text('agents/codex-alpha/MEMORY.md'), `${indexLine('deploys', 'How deploys go, by an agent')}\n${indexLine('deploy-steps', 'Deploy steps')}\n`);
});

test('a retired note is never deleted when the note it went to could not be written', async (t) => {
  const b = bucket();
  const run = await organizeRun(t, b, mergeEdit);
  let armed = true;
  b.fake.onRequest(({ method, key }) => {
    if (armed && method === 'PUT' && key === 'agents/codex-alpha/deploys.md') {
      armed = false;
      b.fake.failNext(3, 503);
    }
  });
  await assert.rejects(
    applyAgentScope({ s3: b.s3, agent: 'codex-alpha', plan: run.plan, changes: run.ev.changes, liveDir: run.liveDir, workDir: run.workDir }),
    (err) => err.partial === true && /put failed: 503/.test(err.message),
  );
  assert.equal(b.text('agents/codex-alpha/deploy-steps.md'), apiNote('deploy-steps', 'Deploy steps', FACTS));
  assert.equal(b.fake.requests.filter((r) => r.method === 'DELETE').length, 0);
});

test('a retired note that an agent writes again right after it was deleted keeps its index line', async (t) => {
  const b = bucket();
  const run = await organizeRun(t, b, mergeEdit);
  let deleted = false;
  let done = false;
  b.fake.onRequest(({ method, key }) => {
    if (method === 'DELETE' && key === 'agents/codex-alpha/deploy-steps.md') deleted = true;
    else if (deleted && !done && method === 'GET' && key === '') {
      done = true;
      agentWrites(b, 'deploy-steps', 'Deploy steps', 'An agent wrote the deploy steps once more.');
    }
  });
  const res = await applyAgentScope({ s3: b.s3, agent: 'codex-alpha', plan: run.plan, changes: run.ev.changes, liveDir: run.liveDir, workDir: run.workDir });
  assert.equal(res.deleted, 1);
  assert.match(b.text('agents/codex-alpha/deploy-steps.md'), /once more/);
  assert.equal(b.text('agents/codex-alpha/MEMORY.md'), `${indexLine('deploys', 'How deploys go, with the steps')}\n${indexLine('deploy-steps', 'Deploy steps')}\n`);
});

test('search entries that do not describe the notes are found by the copy and rewritten from the notes', async (t) => {
  const b = bucket();
  // As after a write that stopped part-way: the snapshot holds the merge, the notes do not.
  const doc = b.snapshot();
  doc.notes = doc.notes.filter((n) => n.path !== 'agents/codex-alpha/deploy-steps.md');
  doc.notes.find((n) => n.path === 'agents/codex-alpha/deploys.md').body = 'the merged text that never reached the note';
  b.put(SNAPSHOT_KEY, JSON.stringify(doc));
  const run = await organizeRun(t, b, () => {});
  assert.equal(run.plan.inStep, false);
  assert.deepEqual(run.ev.changes, []);
  const res = await applyAgentScope({ s3: b.s3, agent: 'codex-alpha', plan: run.plan, changes: [], liveDir: run.liveDir, workDir: run.workDir });
  assert.equal(res.outcome, 'applied');
  const entries = b.snapshot().notes.filter((n) => n.path?.startsWith('agents/codex-alpha/'));
  assert.deepEqual(entries.map((n) => [n.path, n.body]), [
    ['agents/codex-alpha/deploy-steps.md', FACTS],
    ['agents/codex-alpha/deploys.md', FACTS],
  ]);
  // A scope in step stays in step, line ends and trailing blank lines of the API's text aside.
  const fresh = bucket();
  const doc2 = fresh.snapshot();
  doc2.notes.find((n) => n.path === 'agents/codex-alpha/deploys.md').body = `${FACTS}\r\n\n`;
  fresh.put(SNAPSHOT_KEY, JSON.stringify(doc2));
  assert.equal((await organizeRun(t, fresh, () => {})).plan.inStep, true);
});

test('a work file that changed after it was checked is refused before anything is written', async (t) => {
  const b = bucket();
  const run = await organizeRun(t, b, mergeEdit);
  writeFileSync(join(run.workDir, 'deploys.md'), apiNote('deploys', 'Changed later', 'Text nobody checked.'));
  const objects = new Map(b.fake.objects);
  const res = await applyAgentScope({ s3: b.s3, agent: 'codex-alpha', plan: run.plan, changes: run.ev.changes, liveDir: run.liveDir, workDir: run.workDir });
  assert.deepEqual(res, { outcome: 'rejected', errors: ['notes/deploys.md: the file changed after it was checked'] });
  assert.deepEqual([...b.fake.objects.entries()], [...objects.entries()]);
  assert.equal(b.fake.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE').length, 0);
});

test('entries out of step are rewritten from the copy after a rejected result, and only then', async (t) => {
  const b = bucket();
  const doc = b.snapshot();
  doc.notes.find((n) => n.path === 'agents/codex-alpha/deploys.md').body = 'stale text';
  b.put(SNAPSHOT_KEY, JSON.stringify(doc));
  const run = await organizeRun(t, b, (w) => w('deploys.md', apiNote('deploys', 'How deploys go', 'Deploys exist.')));
  assert.notDeepEqual(run.ev.errors, []);
  assert.equal(await repairAgentEntries({ s3: b.s3, agent: 'codex-alpha', plan: run.plan, liveDir: run.liveDir }), true);
  assert.equal(b.snapshot().notes.find((n) => n.path === 'agents/codex-alpha/deploys.md').body, FACTS);
  assert.equal(b.text('agents/codex-alpha/deploys.md'), apiNote('deploys', 'How deploys go', FACTS), 'the note itself is untouched');
  // A scope whose entries are in step gets no write.
  const fresh = bucket();
  const steady = await organizeRun(t, fresh, () => {});
  assert.equal(await repairAgentEntries({ s3: fresh.s3, agent: 'codex-alpha', plan: steady.plan, liveDir: steady.liveDir }), false);
  assert.equal(fresh.fake.requests.filter((r) => r.method === 'PUT').length, 0);
});

test('a scope that holds an object too large to be a note is skipped', async (t) => {
  const b = bucket();
  b.put('agents/codex-alpha/huge.md', 'x'.repeat(1_000_001));
  await assert.rejects(copyAgentScope({ s3: b.s3, agent: 'codex-alpha', dir: tempDir(t) }), (err) => err.skip === true && /larger than 1000000 bytes/.test(err.message));
});

test('the S3 clients take credentials from the block\'s one source, exchange them for the role, and renew them', async () => {
  let time = 0;
  const calls = [];
  const deps = {
    environmentCredentials: () => { calls.push('environment'); return { accessKeyId: 'ENV', secretAccessKey: 's', sessionToken: 't' }; },
    imdsCredentials: async () => { calls.push('instance'); return { accessKeyId: 'IMDS', secretAccessKey: 's', sessionToken: 't' }; },
    assumeRole: async (args) => { calls.push(`assume ${args.roleArn} ${args.sessionName} ${args.region} ${args.credentials.accessKeyId}`); return { accessKeyId: 'ROLE', secretAccessKey: 's', sessionToken: 't' }; },
    createS3: (args) => ({ args }),
    clock: () => time,
  };
  const block = { bucket: 'example-bucket', region: 'ap-northeast-1', roleArn: null, credentials: 'environment' };
  const env = agentScopesS3(block, deps);
  assert.equal((await env()).args.credentials.accessKeyId, 'ENV');
  const role = agentScopesS3({ ...block, credentials: 'instance', roleArn: 'arn:aws:iam::123456789012:role/agent-memory-prod-organizer' }, deps);
  const signal = new AbortController().signal;
  const first = await role({ signal });
  assert.equal(first.args.credentials.accessKeyId, 'ROLE');
  assert.equal(first.args.signal, signal);
  assert.equal(first.args.bucket, 'example-bucket');
  time = 9 * 60 * 1000;
  await role();
  time = 11 * 60 * 1000;
  await role();
  assert.deepEqual(calls, [
    'environment',
    'instance', 'assume arn:aws:iam::123456789012:role/agent-memory-prod-organizer agent-memory-organizer ap-northeast-1 IMDS',
    'instance', 'assume arn:aws:iam::123456789012:role/agent-memory-prod-organizer agent-memory-organizer ap-northeast-1 IMDS',
  ]);
});

test('mergeIndex keeps the result and carries over what the API wrote meanwhile', () => {
  const base = '- [a](a.md) — A\n- [b](b.md) — B\n';
  const result = '- [a](a.md) — A, merged with B\n';
  assert.equal(mergeIndex(result, base, base), result);
  assert.equal(mergeIndex(result, base, `${base}- [c](c.md) — new\n`), `${result}- [c](c.md) — new\n`);
  assert.equal(mergeIndex(result, base, '- [a](a.md) — A rewritten by an agent\n- [b](b.md) — B\n'), '- [a](a.md) — A rewritten by an agent\n');
  assert.equal(mergeIndex(result, base, base, ['b.md']), `${result}- [b](b.md) — B\n`);
  assert.equal(mergeIndex('', '', ''), '');
});

test('the organizer state lives in the bucket and is updated conditionally', async () => {
  const b = bucket();
  const plain = (state) => JSON.parse(JSON.stringify(state));
  assert.deepEqual(plain(await readOrganizerState(b.s3)), { version: 1, scopes: {} });
  await recordOrganizerState(b.s3, 'codex-alpha', (e) => ({ ...e, lastOrganize: '2026-11-18T00:00:00.000Z' }));
  await recordOrganizerState(b.s3, 'claude-beta', (e) => ({ ...e, lastOrganizeTried: '2026-11-18T00:00:00.000Z' }));
  await recordOrganizerState(b.s3, 'codex-alpha', (e) => ({ ...e, organizedDigest: 'abc' }));
  assert.deepEqual(plain(await readOrganizerState(b.s3)), {
    version: 1,
    scopes: {
      'codex-alpha': { lastOrganize: '2026-11-18T00:00:00.000Z', organizedDigest: 'abc' },
      'claude-beta': { lastOrganizeTried: '2026-11-18T00:00:00.000Z' },
    },
  });
  const puts = b.fake.requests.filter((r) => r.method === 'PUT' && r.key === STATE_KEY);
  assert.equal(puts[0].headers['if-none-match'], '*');
  assert.ok(puts.slice(1).every((r) => r.headers['if-match'] !== undefined));
  b.put(STATE_KEY, 'not json');
  assert.deepEqual(plain(await readOrganizerState(b.s3)), { version: 1, scopes: {} });
  b.put(STATE_KEY, JSON.stringify({ scopes: { '../x': {}, ok: { a: 1 }, bad: 'x' } }));
  assert.deepEqual(plain(await readOrganizerState(b.s3)), { version: 1, scopes: { ok: { a: 1 } } });
});
