import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDomains } from '../lib/domains.mjs';
import {
  FAILURES_IN_A_ROW, TOKEN_MAX_AGE_MS, labelReport, labelResults, nextLabelRecord, planLabelBatches, selectTouched, sendBatches,
} from '../lib/label-run.mjs';

const hex = (c) => c.repeat(64);
const scopeOf = (path) => path.slice(0, path.lastIndexOf('/'));
// A note as the label passes give it: the file's digest, its label (null when it has none).
const note = (path, { digest = hex('0'), domain = null, skip = null } = {}) => ({
  path, scope: scopeOf(path), digest, domain, name: `name of ${path}`, description: `About ${path}`, body: `Body of ${path}.`, skip,
});
const domainsOf = (extra = {}) => parseDomains(JSON.stringify({ version: 1, defaults: {}, exceptions: {}, ...extra })).value;
const paths = (notes) => notes.map((n) => n.path);

test('the first run records labeled notes and sends the others', () => {
  const notes = [
    note('global/a.md', { digest: hex('1'), domain: 'work' }),
    note('global/b.md', { digest: hex('2') }),
    note('projects/p/c.md', { digest: hex('3'), domain: 'general' }),
    note('projects/p/d.md', { digest: hex('4') }),
  ];
  const { touched, confirmed } = selectTouched({ notes, record: null, all: false });
  assert.deepEqual(paths(touched), ['global/b.md', 'projects/p/d.md']);
  assert.equal(touched[0], notes[1], 'the notes themselves, not copies');
  assert.deepEqual(confirmed, [{ path: 'global/a.md', digest: hex('1') }, { path: 'projects/p/c.md', digest: hex('3') }]);
});

test('a changed digest makes a note touched', () => {
  const notes = [
    note('global/a.md', { digest: hex('1'), domain: 'work' }),
    note('global/b.md', { digest: hex('2'), domain: 'personal' }),
    note('global/c.md', { digest: hex('3'), domain: 'general' }),
    note('global/d.md', { digest: hex('4') }),
  ];
  // a is as it was recorded; b changed since; c and d were never recorded, labeled or not.
  const record = { 'global/a.md': hex('1'), 'global/b.md': hex('9'), 'global/gone.md': hex('5') };
  const { touched, confirmed } = selectTouched({ notes, record, all: false });
  assert.deepEqual(paths(touched), ['global/b.md', 'global/c.md', 'global/d.md']);
  assert.deepEqual(confirmed, []);
  // A recorded digest that is not the note's own entry (an inherited name) never counts.
  assert.deepEqual(paths(selectTouched({ notes: [note('global/constructor')], record: {}, all: false }).touched), ['global/constructor']);
});

test('--all touches every note', () => {
  const notes = [note('global/a.md', { digest: hex('1'), domain: 'work' }), note('projects/p/b.md', { digest: hex('2') })];
  for (const record of [null, { 'global/a.md': hex('1'), 'projects/p/b.md': hex('2') }]) {
    const { touched, confirmed } = selectTouched({ notes, record, all: true });
    assert.deepEqual(paths(touched), ['global/a.md', 'projects/p/b.md']);
    assert.deepEqual(confirmed, []);
  }
});

test('an exception bypasses the model', () => {
  const domains = domainsOf({ exceptions: { 'global/a.md': 'personal', 'global/b.md': 'work', 'global/gone.md': 'general' } });
  const notes = [
    note('global/a.md', { digest: hex('1'), domain: 'work' }),
    note('global/b.md', { digest: hex('2') }),
    note('global/c.md', { digest: hex('3') }),
  ];
  // a is not touched: its exception applies all the same, on every run.
  const { exceptions, batches } = planLabelBatches({ notes, touched: [notes[1], notes[2]], domains, batchNotes: 19 });
  assert.deepEqual(exceptions, [
    { path: 'global/a.md', label: 'personal', digest: hex('1') },
    { path: 'global/b.md', label: 'work', digest: hex('2') },
  ]);
  assert.deepEqual(batches.map((b) => [b.scope, paths(b.notes)]), [['global', ['global/c.md']]]);
  // Nothing touched: the exceptions still apply, and there is no batch.
  const quiet = planLabelBatches({ notes, touched: [], domains, batchNotes: 19 });
  assert.equal(quiet.exceptions.length, 2);
  assert.deepEqual(quiet.batches, []);
});

test('batches hold one scope and at most batchNotes notes', () => {
  const domains = domainsOf({ defaults: { 'projects/p': 'work' } });
  const touched = [
    ...['a', 'b', 'c', 'd', 'e'].map((x) => note(`global/${x}.md`)),
    note('projects/p/f.md', { domain: 'personal' }), note('projects/p/g.md'),
    note('global/h.md'),
  ];
  const { exceptions, batches } = planLabelBatches({ notes: touched, touched, domains, batchNotes: 2 });
  assert.deepEqual(exceptions, []);
  assert.deepEqual(batches.map((b) => [b.scope, paths(b.notes)]), [
    ['global', ['global/a.md', 'global/b.md']],
    ['global', ['global/c.md', 'global/d.md']],
    ['global', ['global/e.md', 'global/h.md']],
    ['projects/p', ['projects/p/f.md', 'projects/p/g.md']],
  ]);
  for (const batch of batches) {
    assert.deepEqual(batch.notes.map((n) => n.id), ['n001', 'n002']);
    assert.ok(batch.notes.every((n) => n.scope === batch.scope));
  }
  // Each note carries what the model is shown, its scope's default, and what the pass needs back.
  assert.deepEqual(batches[3].notes[0], {
    ...touched[5], id: 'n001', default: 'work',
  });
  assert.equal(batches[0].notes[0].default, 'general');
  // Ids are three digits up to the largest batch.
  const many = Array.from({ length: 50 }, (_, i) => note(`global/n${i}.md`));
  assert.equal(planLabelBatches({ notes: many, touched: many, domains, batchNotes: 50 }).batches[0].notes.at(-1).id, 'n050');
});

test('nextLabelRecord drops notes that are gone and keeps skipped ones out', () => {
  const record = {
    'global/a.md': hex('1'), 'global/gone.md': hex('2'), 'global/s.md': hex('3'), 'global/w.md': hex('4'),
    'global/c.md': hex('5'),
  };
  const next = nextLabelRecord(record, {
    // s.md is present but was skipped this run: its old entry stays (its digest no longer matches it).
    // n.md is new and was skipped: it gets no entry.
    present: ['global/a.md', 'global/s.md', 'global/w.md', 'global/n.md', 'global/c.md', 'global/u.md'],
    written: [{ path: 'global/w.md', digest: hex('6') }, { path: 'global/c.md', digest: hex('7') }],
    unchanged: [{ path: 'global/u.md', digest: hex('8') }],
    // c.md was recorded as it was and then written by an exception: the written digest wins.
    confirmed: [{ path: 'global/c.md', digest: hex('9') }],
  });
  assert.deepEqual(next, {
    'global/a.md': hex('1'), 'global/c.md': hex('7'), 'global/s.md': hex('3'), 'global/u.md': hex('8'), 'global/w.md': hex('6'),
  });
  assert.deepEqual(Object.keys(next), Object.keys(next).sort(), 'sorted by path');
  assert.deepEqual({ ...nextLabelRecord(null, { present: ['global/a.md'], written: [], unchanged: [], confirmed: [{ path: 'global/a.md', digest: hex('1') }] }) },
    { 'global/a.md': hex('1') });
});

test('nextLabelRecord drops the entries of notes the run took but did not label', () => {
  // After an --all run, a note not reached still matches its entry: it loses it, so the next run sends it.
  const record = { 'global/a.md': hex('1'), 'global/b.md': hex('2'), 'global/c.md': hex('3') };
  const next = nextLabelRecord(record, {
    present: ['global/a.md', 'global/b.md', 'global/c.md'],
    written: [{ path: 'global/a.md', digest: hex('4') }],
    left: ['global/b.md'],
  });
  assert.deepEqual(next, { 'global/a.md': hex('4'), 'global/c.md': hex('3') });
});

// Batches of one note each, one per scope, as planLabelBatches gives them.
const batchesOf = (...scopes) => scopes.map((scope) => ({ scope, notes: [{ ...note(`${scope}/n.md`), id: 'n001', default: 'general' }] }));
const leftOf = (out) => Object.fromEntries(out.left);

// A stand-in for the caller's labelBatch call: the calls whose number (from 1) is in `fails` fail,
// the others label every note `work`; each costs `cost` and moves `clock` on by `step` ms.
function fakeModel({ fails = [], cost = 0.25, clock = null, step = 0, onCall = () => {} } = {}) {
  const calls = [];
  const labelBatch = async (notes) => {
    calls.push(notes.map((n) => n.path));
    if (clock) clock.ms += step;
    onCall(calls.length);
    if (fails.includes(calls.length)) return { ok: false, error: 'Mantle Responses HTTP 500', costUsd: 0, requests: 1 };
    return { ok: true, labels: new Map(notes.map((n) => [n.id, { label: 'work', reason: `reason for ${n.path}` }])), costUsd: cost, requests: 1 };
  };
  return { labelBatch, calls };
}
const run = (batches, model, extra = {}) => sendBatches({ batches, labelBatch: model.labelBatch, ceiling: 5, now: () => 0, tokenAt: 0, ...extra });

test('sendBatches goes on after a failed batch', async () => {
  const model = fakeModel({ fails: [1] });
  const out = await run(batchesOf('global', 'projects/p', 'projects/q'), model);
  assert.deepEqual(model.calls, [['global/n.md'], ['projects/p/n.md'], ['projects/q/n.md']]);
  assert.equal(out.stop, null);
  assert.equal(out.failed, true);
  assert.deepEqual(Object.fromEntries(out.labels), {
    'projects/p/n.md': { label: 'work', reason: 'reason for projects/p/n.md' },
    'projects/q/n.md': { label: 'work', reason: 'reason for projects/q/n.md' },
  });
  assert.deepEqual(leftOf(out), { 'global/n.md': 'the model call failed (Mantle Responses HTTP 500)' });
  assert.deepEqual([out.spent, out.requests, out.sent], [0.5, 3, 3]);
  // A success between two failures starts the count again.
  const apart = fakeModel({ fails: [1, 3] });
  assert.equal((await run(batchesOf('global', 'projects/p', 'projects/q', 'projects/r'), apart)).stop, null);
  assert.equal(apart.calls.length, 4);
});

test('sendBatches stops after two failed batches in a row', async () => {
  assert.equal(FAILURES_IN_A_ROW, 2);
  const model = fakeModel({ fails: [2, 3] });
  const out = await run(batchesOf('global', 'projects/p', 'projects/q', 'projects/r', 'projects/s'), model);
  assert.deepEqual(model.calls, [['global/n.md'], ['projects/p/n.md'], ['projects/q/n.md']]);
  assert.equal(out.stop, 'failures');
  assert.equal(out.failed, true);
  assert.deepEqual([...out.labels.keys()], ['global/n.md']);
  assert.deepEqual(leftOf(out), {
    'projects/p/n.md': 'the model call failed (Mantle Responses HTTP 500)',
    'projects/q/n.md': 'the model call failed (Mantle Responses HTTP 500)',
    'projects/r/n.md': 'not sent; two batches in a row failed',
    'projects/s/n.md': 'not sent; two batches in a row failed',
  });
});

test('sendBatches stops at the cost ceiling, which is not a failure', async () => {
  const model = fakeModel({ cost: 0.6 });
  const out = await run(batchesOf('global', 'projects/p', 'projects/q'), model, { ceiling: 1 });
  // 0.6 after the first batch is below the ceiling; 1.2 after the second is not.
  assert.equal(model.calls.length, 2);
  assert.equal(out.stop, 'ceiling');
  assert.equal(out.failed, false);
  assert.deepEqual(leftOf(out), { 'projects/q/n.md': 'not sent; the model cost of this run reached its ceiling' });
  assert.equal(out.spent, 1.2);
});

test('sendBatches stops when the token is near the end of its hour', async () => {
  assert.equal(TOKEN_MAX_AGE_MS, 55 * 60 * 1000);
  const minutes = 60 * 1000;
  // Each call takes 30 minutes: the third batch would start with a token an hour old.
  const clock = { ms: 1_000_000 };
  const model = fakeModel({ clock, step: 30 * minutes });
  const out = await run(batchesOf('global', 'projects/p', 'projects/q'), model, { now: () => clock.ms, tokenAt: clock.ms });
  assert.equal(model.calls.length, 2);
  assert.equal(out.stop, 'token-age');
  assert.equal(out.failed, false);
  assert.deepEqual(leftOf(out), { 'projects/q/n.md': 'not sent; the label token of this run was near the end of its hour' });
  // The limit itself stops; a millisecond less does not; a token of unknown age never stops.
  const at = (age) => run(batchesOf('global'), fakeModel(), { now: () => clock.ms, tokenAt: clock.ms - age });
  assert.equal((await at(55 * minutes)).stop, 'token-age');
  assert.equal((await at(55 * minutes - 1)).stop, null);
  assert.equal((await run(batchesOf('global'), fakeModel(), { now: () => clock.ms, tokenAt: null })).stop, null);
});

test('sendBatches stops when the signal aborts', async () => {
  const abort = new AbortController();
  const model = fakeModel({ onCall: () => abort.abort() });
  const out = await run(batchesOf('global', 'projects/p'), model, { signal: abort.signal });
  assert.equal(model.calls.length, 1);
  assert.equal(out.stop, 'interrupted');
  assert.deepEqual(out.labels, new Map());
  assert.deepEqual(Object.keys(leftOf(out)), ['global/n.md', 'projects/p/n.md']);
  // Aborted before it starts: nothing is sent.
  const none = fakeModel();
  assert.equal((await run(batchesOf('global'), none, { signal: abort.signal })).stop, 'interrupted');
  assert.deepEqual(none.calls, []);
});

// The results of a run over global/ and projects/p, as a workstation pass builds them.
function sampleResults() {
  const notes = [
    note('global/a.md', { domain: null }),
    note('global/b.md', { domain: 'general' }),
    note('global/c.md', { domain: 'work' }),
    note('global/d.md', { skip: 'no frontmatter' }),
    note('global/e.md', { domain: 'personal' }),
    note('projects/p/f.md', { domain: 'work' }),
  ];
  const planned = new Map([
    ['global/a.md', { label: 'work', reason: 'about the job', exception: false }],
    ['global/b.md', { label: 'personal', reason: null, exception: true }],
    ['global/e.md', { label: 'personal', reason: 'the same as before', exception: false }],
  ]);
  const left = new Map([['global/c.md', 'the model call failed (Mantle Responses HTTP 500)']]);
  const exceptions = new Map([['global/b.md', 'personal'], ['global/gone.md', 'work'], ['projects/q/x.md', 'work']]);
  return labelResults({ scopes: ['global', 'projects/p'], notes, planned, left, exceptions });
}

test('labelResults gives each scope its changes, counts, notes left and exceptions without a note', () => {
  const [global, p] = sampleResults();
  assert.deepEqual(global, {
    scope: 'global',
    labels: [
      { path: 'global/a.md', from: null, to: 'work', reason: 'about the job', exception: false },
      { path: 'global/b.md', from: 'general', to: 'personal', reason: null, exception: true },
    ],
    counts: { work: 2, personal: 2, general: 0, unlabeled: 1 },
    left: [{ path: 'global/c.md', why: 'the model call failed (Mantle Responses HTTP 500)' }],
    repair: [{ path: 'global/d.md', why: 'no frontmatter' }],
    unmatched: ['global/gone.md'],
  });
  // projects/q is not a scope of this run: its exception is not counted.
  assert.deepEqual(p, { scope: 'projects/p', labels: [], counts: { work: 1, personal: 0, general: 0, unlabeled: 0 }, left: [], repair: [], unmatched: [] });
});

test('labelReport shows the labels set or changed, the counts, the notes left and the exceptions without a note', () => {
  assert.equal(labelReport(sampleResults()), [
    '## global',
    '',
    'Labels set or changed:',
    '- global/a.md: unlabeled → work — about the job',
    '- global/b.md: general → personal (exception)',
    '',
    'Labels after this run: 2 work, 2 personal, 0 general, 1 unlabeled',
    '',
    'Left for the next run:',
    '- global/c.md: the model call failed (Mantle Responses HTTP 500)',
    '',
    "Left for Organize's repair:",
    '- global/d.md: no frontmatter',
    '',
    'Exceptions that name no note:',
    '- global/gone.md',
    '',
  ].join('\n'));
  // A scope with nothing to report has no section; a run with none gives no text.
  assert.equal(labelReport([sampleResults()[1]]), '');
});

test('labelReport leaves the model\'s reasons out when asked', () => {
  const text = labelReport(sampleResults(), { reasons: false });
  assert.match(text, /^- global\/a\.md: unlabeled → work$/m);
  assert.match(text, /^- global\/b\.md: general → personal \(exception\)$/m);
  assert.doesNotMatch(text, /about the job/);
  assert.match(text, /^- global\/c\.md: the model call failed \(Mantle Responses HTTP 500\)$/m);
});

test('labelReport withholds a path or a reason that looks like a credential', () => {
  const key = ['AKIA', 'Q3JZ7XK2M4N8P6R1'].join('');
  const [global] = sampleResults();
  const results = [{
    ...global,
    labels: [{ path: `global/${key}.md`, from: null, to: 'work', reason: `the key ${key}`, exception: false }],
    left: [], repair: [], unmatched: [],
  }];
  const text = labelReport(results);
  assert.ok(!text.includes(key));
  assert.match(text, /^- \(file name withheld\): unlabeled → work — \(reason withheld\)$/m);
});
