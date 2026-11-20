import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDomains } from '../lib/domains.mjs';
import { labelReport, labelResults, nextLabelRecord, planLabelBatches, selectTouched } from '../lib/label-run.mjs';

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
