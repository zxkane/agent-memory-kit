import assert from 'node:assert/strict';
import test from 'node:test';
import { labelReport, labelResults } from '../lib/label-run.mjs';
import { buildReport, labelPlanData, labelReportData, labelReportHead, parseReport, reportData } from '../lib/reports.mjs';

// A name that the secret scan flags, built at run time so that this file holds no such literal.
const KEY = ['AKIA', 'Q3JZ7XK2M4N8P6R1'].join('');

// The figures evaluate gives a folder: index lines and bytes before and after, unlisted notes
// before and after, note bytes before and after, retired bytes.
const stats = ([ilb, ibb, ila, iba, ub, ua, nb, na, rb]) => ({
  indexBefore: { lines: ilb, bytes: ibb }, indexAfter: { lines: ila, bytes: iba },
  unlistedBefore: ub, unlistedAfter: ua, notesBytesBefore: nb, notesBytesAfter: na, retiredBytes: rb,
});

// What the apply step gives buildReport, for scopes of every kind.
const CASES = {
  // A project run that changes, retires and adds to global/, with a repair run and scratch files.
  projectOrganize: {
    config: { host: 'alpha' }, kind: 'organize', scope: 'example-project', date: '2026-11-20', model: 'example-model',
    stopReason: 'completed', costUsd: 0.25, turns: 4, denials: 1, repaired: 2, conversation: null,
    pairs: [{ label: 'notes' }, { label: 'global' }],
    snap: { notes: { 'MEMORY.md': 'h1', 'a.md': 'h2', 'b.md': 'h3' }, global: { 'MEMORY.md': 'h4' } },
    ev: {
      changes: [
        { label: 'notes', file: 'b.md', kind: 'retire', target: { label: 'notes', file: 'a.md' } },
        { label: 'global', file: 'new.md', kind: 'add' },
        { label: 'notes', file: 'MEMORY.md', kind: 'change' },
        { label: 'global', file: 'MEMORY.md', kind: 'change' },
        { label: 'notes', file: 'a.md', kind: 'change' },
      ],
      ignored: [], ignoredEntries: { notes: 2 },
      stats: {
        notes: stats([2, 64, 1, 32, 0, 0, 300, 180, 120]), global: stats([1, 30, 2, 61, 0, 0, 100, 160, 0]),
        retention: { termsBefore: 40, termsKept: 37, share: 0.925, checked: 2, lowest: null },
      },
    },
    descriptions: new Map([['global/new.md', 'A new global note']]),
  },
  // An Extract run whose conversation text was cut, with unknown figures and entries not applied.
  extractCut: {
    config: { host: 'beta-2' }, kind: 'extract', scope: 'p q', date: '2026-01-05', model: 'm;x',
    stopReason: 'error_max_turns', costUsd: null, turns: null, denials: null, repaired: 0,
    conversation: { truncated: true, bytes: 10000, sessionsLeftOut: 3 },
    pairs: [{ label: 'notes' }],
    snap: { notes: { 'MEMORY.md': 'h1', 'a.md': 'h2' } },
    ev: {
      changes: [{ label: 'notes', file: 'port.md', kind: 'add' }, { label: 'notes', file: 'MEMORY.md', kind: 'change' }],
      ignored: ['notes/a.md', 'notes/stub.md'], ignoredEntries: { notes: 1 },
      stats: { notes: stats([1, 20, 2, 41, 1, 1, 50, 90, 0]), retention: { termsBefore: 0, termsKept: 0, share: 1, checked: 0, lowest: null } },
    },
    descriptions: new Map([['notes/port.md', 'Staging port — 8443']]),
  },
  // global/ on its own, with a note name that looks like a credential and one without a description.
  globalWithheld: {
    config: { host: 'alpha' }, kind: 'organize', scope: 'global', date: '2026-11-20', model: 'example-model',
    stopReason: 'completed', costUsd: 1.005, turns: 12, denials: 0, repaired: 0, conversation: { truncated: false, bytes: 1234, sessionsLeftOut: 0 },
    pairs: [{ label: 'notes' }],
    snap: { notes: { 'MEMORY.md': 'h1', [`${KEY}.md`]: 'h2' } },
    ev: {
      changes: [
        { label: 'notes', file: `${KEY}.md`, kind: 'retire', target: { label: 'notes', file: 'keys.md' } },
        { label: 'notes', file: 'keys.md', kind: 'add' },
        { label: 'notes', file: `x${KEY}.md`, kind: 'add' },
      ],
      ignored: [], ignoredEntries: {},
      stats: { notes: stats([3, 90, 3, 91, 2, 1, 500, 480, 40]), retention: { termsBefore: 7, termsKept: 7, share: 1, checked: 1, lowest: null } },
    },
    descriptions: new Map([['notes/keys.md', 'Where the keys are kept']]),
  },
  // No change at all: only the head and a count of scratch files in global/.
  nothing: {
    config: { host: 'alpha' }, kind: 'organize', scope: 'p', date: '2026-11-20', model: 'example-model',
    stopReason: 'completed', costUsd: 0, turns: 1, denials: 0, conversation: undefined,
    pairs: [{ label: 'notes' }, { label: 'global' }],
    snap: { notes: {}, global: {} },
    ev: {
      changes: [], ignored: [], ignoredEntries: { global: 1 },
      stats: { notes: stats([0, 0, 0, 0, 0, 0, 0, 0, 0]), global: stats([4, 100, 4, 100, 0, 0, 10, 10, 0]), retention: { termsBefore: 0, termsKept: 0, share: 1 } },
    },
    descriptions: new Map(),
  },
  // A project run that changes global/ only.
  onlyGlobal: {
    config: { host: 'alpha' }, kind: 'organize', scope: 'p', date: '2026-11-20', model: 'example-model',
    stopReason: 'completed', costUsd: 0.3, turns: 2, denials: 0, repaired: 1, conversation: null,
    pairs: [{ label: 'notes' }, { label: 'global' }],
    snap: { notes: { 'MEMORY.md': 'h' }, global: { 'MEMORY.md': 'h2', 'old.md': 'h3' } },
    ev: {
      changes: [{ label: 'global', file: 'g.md', kind: 'add' }, { label: 'global', file: 'old.md', kind: 'change' }],
      ignored: ['notes/x.md'], ignoredEntries: { notes: 1, global: 3 },
      stats: { notes: stats([5, 200, 5, 200, 0, 0, 900, 900, 0]), global: stats([1, 10, 1, 10, 1, 2, 30, 80, 0]), retention: { termsBefore: 9, termsKept: 3, share: 1 / 3 } },
    },
    descriptions: new Map(),
  },
};

// Each report exactly as the kit has always written it.
const GOLDEN = {
  projectOrganize: [
    '# Organize example-project — 2026-11-20 on alpha',
    '',
    '- Model: example-model; turns: 4; cost: USD 0.25; stopped: completed; denials: 1',
    '- Repair: one repair run; the first check found 2 problem(s)',
    '- Index: 2 lines, 64 bytes → 1 lines, 32 bytes',
    '- Index (global/): 1 lines, 30 bytes → 2 lines, 61 bytes',
    '- Notes not listed in the index: 0 → 0',
    '- Notes not listed in the index (global/): 0 → 0',
    '- Notes: 300 bytes → 180 bytes; retired: 120 bytes',
    '- Notes (global/): 100 bytes → 160 bytes; retired: 0 bytes',
    '- Distinct terms kept: 92% (37 of 40)',
    '',
    '## Added',
    '- global/new.md — A new global note',
    '## Changed',
    '- MEMORY.md',
    '- a.md',
    '- global/MEMORY.md',
    '## Retired',
    '- b.md → a.md',
    '## Not applied',
    '- (2 entries that are not note files): ignored',
  ],
  extractCut: [
    '# Extract p q — 2026-01-05 on beta-2',
    '',
    '- Model: m;x; turns: unknown; cost: USD unknown; stopped: error_max_turns; denials: unknown',
    '- Conversation text: cut to 10000 bytes; 3 session(s) left out',
    '- Index: 1 lines, 20 bytes → 2 lines, 41 bytes',
    '- Notes not listed in the index: 1 → 1',
    '- Notes: 50 bytes → 90 bytes; retired: 0 bytes',
    '- Distinct terms kept: 100% (0 of 0)',
    '',
    '## Added',
    '- port.md — Staging port — 8443',
    '## Changed',
    '- MEMORY.md',
    '## Not applied',
    '- a.md: retiring a note is not part of an extract run',
    '- stub.md: a new file cannot be a retirement',
    '- (1 entry that is not a note file): ignored',
  ],
  globalWithheld: [
    '# Organize global — 2026-11-20 on alpha',
    '',
    '- Model: example-model; turns: 12; cost: USD 1.00; stopped: completed; denials: 0',
    '- Conversation text: complete',
    '- Index: 3 lines, 90 bytes → 3 lines, 91 bytes',
    '- Notes not listed in the index: 2 → 1',
    '- Notes: 500 bytes → 480 bytes; retired: 40 bytes',
    '- Distinct terms kept: 100% (7 of 7)',
    '',
    '## Added',
    '- keys.md — Where the keys are kept',
    `- x${KEY}.md — (no description)`,
    '## Retired',
    '- (file name withheld) → keys.md',
  ],
  nothing: [
    '# Organize p — 2026-11-20 on alpha',
    '',
    '- Model: example-model; turns: 1; cost: USD 0.00; stopped: completed; denials: 0',
    '- Index: 0 lines, 0 bytes → 0 lines, 0 bytes',
    '- Notes not listed in the index: 0 → 0',
    '- Distinct terms kept: 100% (0 of 0)',
    '',
    '## Not applied',
    '- global/(1 entry that is not a note file): ignored',
  ],
  onlyGlobal: [
    '# Organize p — 2026-11-20 on alpha',
    '',
    '- Model: example-model; turns: 2; cost: USD 0.30; stopped: completed; denials: 0',
    '- Repair: one repair run; the first check found 1 problem(s)',
    '- Index: 5 lines, 200 bytes → 5 lines, 200 bytes',
    '- Index (global/): 1 lines, 10 bytes → 1 lines, 10 bytes',
    '- Notes not listed in the index: 0 → 0',
    '- Notes not listed in the index (global/): 1 → 2',
    '- Notes (global/): 30 bytes → 80 bytes; retired: 0 bytes',
    '- Distinct terms kept: 33% (3 of 9)',
    '',
    '## Added',
    '- global/g.md — (no description)',
    '## Changed',
    '- global/old.md',
    '## Not applied',
    '- x.md: a new file cannot be a retirement',
    '- (1 entry that is not a note file): ignored',
    '- global/(3 entries that are not note files): ignored',
  ],
};

test('buildReport renders each report byte for byte as before', () => {
  for (const [name, c] of Object.entries(CASES)) assert.equal(buildReport(c), `${GOLDEN[name].join('\n')}\n`, name);
  assert.ok(!buildReport(CASES.globalWithheld).includes(`- ${KEY}`), 'a name that looks like a credential is withheld');
});

test('labelReportHead gives the head of the label report as before', () => {
  const head = labelReportHead({
    date: '2026-11-20', host: 'alpha', model: 'example-label-model', requests: 3, costUsd: 0.0149, touched: 7, sent: 5, exceptions: 1, confirmed: 2,
  });
  assert.deepEqual(head, [
    '# Labels — 2026-11-20 on alpha',
    '',
    '- Model: example-label-model; requests: 3; cost: USD 0.01',
    '- Notes: 7 touched, 5 sent to the model, 1 with an exception, 2 recorded as they were',
  ]);
});

test('reportData gives the figures of the report as JSON, without a description or a text', () => {
  const data = reportData(CASES.projectOrganize);
  assert.deepEqual(data, {
    schemaVersion: 1, host: 'alpha', kind: 'organize', scope: 'example-project', date: '2026-11-20', model: 'example-model',
    stopReason: 'completed', costUsd: 0.25, turns: 4, denials: 1, repaired: 2, conversation: null,
    folders: [
      {
        folder: 'projects/example-project', changed: true, indexBefore: { lines: 2, bytes: 64 }, indexAfter: { lines: 1, bytes: 32 },
        unlistedBefore: 0, unlistedAfter: 0, notesBytesBefore: 300, notesBytesAfter: 180, retiredBytes: 120,
      },
      {
        folder: 'global', changed: true, indexBefore: { lines: 1, bytes: 30 }, indexAfter: { lines: 2, bytes: 61 },
        unlistedBefore: 0, unlistedAfter: 0, notesBytesBefore: 100, notesBytesAfter: 160, retiredBytes: 0,
      },
    ],
    retention: { termsKept: 37, termsBefore: 40, share: 0.925 },
    counts: { added: 1, changed: 3, retired: 1, notApplied: 2 },
    changes: [
      { kind: 'add', path: 'global/new.md' },
      { kind: 'change', path: 'MEMORY.md' },
      { kind: 'change', path: 'a.md' },
      { kind: 'change', path: 'global/MEMORY.md' },
      { kind: 'retire', path: 'b.md', target: 'a.md' },
    ],
  });
  assert.doesNotMatch(JSON.stringify(data), /A new global note/);
  // Every folder of the scope is listed, also one the run did not change; Extract says what reached the model.
  const extract = reportData(CASES.extractCut);
  assert.deepEqual(extract.conversation, { truncated: true, bytes: 10000, sessionsLeftOut: 3 });
  assert.deepEqual([extract.costUsd, extract.turns, extract.denials, extract.scope], [null, null, null, 'p q']);
  assert.deepEqual(extract.counts, { added: 1, changed: 1, retired: 0, notApplied: 3 });
  assert.deepEqual(reportData(CASES.nothing).folders.map((f) => [f.folder, f.changed]), [['projects/p', false], ['global', false]]);
  assert.deepEqual(reportData(CASES.globalWithheld).folders.map((f) => f.folder), ['global']);
  // A name that looks like a credential is withheld as in the report.
  const withheld = reportData(CASES.globalWithheld);
  assert.deepEqual(withheld.changes.filter((c) => c.kind === 'retire'), [{ kind: 'retire', path: '(file name withheld)', target: 'keys.md' }]);
  assert.ok(!JSON.stringify(withheld).includes(`"${KEY}.md"`));
});

// What the Markdown of a report holds of its JSON: the cost in cents, no size of a complete
// conversation, and the folders it shows (its own, and global/ when the run changed it), with
// note sizes only for a folder the run changed.
function markdownView(data) {
  const own = data.folders[0].folder;
  return {
    ...data,
    costUsd: data.costUsd === null ? null : Number(data.costUsd.toFixed(2)),
    conversation: data.conversation && { ...data.conversation, bytes: data.conversation.truncated ? data.conversation.bytes : null },
    folders: data.folders.filter((f) => f.folder === own || f.changed)
      .map((f) => (f.changed ? f : { ...f, notesBytesBefore: null, notesBytesAfter: null, retiredBytes: null })),
  };
}

test('parseReport reads back from the Markdown what buildReport wrote', () => {
  for (const [name, c] of Object.entries(CASES)) assert.deepEqual(parseReport(buildReport(c)), markdownView(reportData(c)), name);
  // A long cost and every share of terms survive as the report shows them.
  const c = { ...CASES.onlyGlobal, costUsd: 0.123456, ev: { ...CASES.onlyGlobal.ev, stats: { ...CASES.onlyGlobal.ev.stats, retention: { termsBefore: 7, termsKept: 2, share: 2 / 7 } } } };
  const back = parseReport(buildReport(c));
  assert.equal(back.costUsd, 0.12);
  assert.deepEqual(back.retention, { termsKept: 2, termsBefore: 7, share: 2 / 7 });
});

test('parseReport returns null for a text that is not a report the kit wrote', () => {
  const good = buildReport(CASES.projectOrganize);
  const bad = [
    '', '# old\n', 'kept\n', '# Organize p — 2026-11-20 on alpha\n',
    good.replace('- Notes not listed in the index: 0 → 0\n', '- Something else: 1\n'),
    good.replace('## Retired\n', '## Moved\n'),
    good.replace('- Distinct terms kept: 92% (37 of 40)\n', ''),
    good.replace('- Model: example-model; turns: 4;', '- Model: example-model; turns: four;'),
    good.replace('- b.md → a.md\n', 'b.md → a.md\n'),
    good.replace(' on alpha\n', ' on Alpha\n'),
    '# Labels — 2026-11-20 on alpha\n\n- Model: m; requests: x; cost: USD 0.00\n',
  ];
  for (const text of bad) assert.equal(parseReport(text), null, JSON.stringify(text.slice(0, 80)));
});

// A label run over global/ and projects/p, as the driver sees it before label-apply.
function labelRun() {
  const note = (path, domain = null, skip = null) => ({ path, scope: path.slice(0, path.lastIndexOf('/')), digest: '0'.repeat(64), domain, skip });
  const notes = [
    note('global/a.md'), note('global/b.md', 'general'), note('global/c.md', 'work'), note('global/d.md', null, 'no frontmatter'),
    note('global/e.md', 'personal'), note('global/h.md', 'work'), note('projects/p/f.md', 'work'), note('projects/p/g.md'),
  ];
  const planned = new Map([
    ['global/a.md', { label: 'work', reason: 'MODEL-REASON about the job', exception: false }],
    ['global/b.md', { label: 'personal', reason: null, exception: true }],
    ['global/e.md', { label: 'personal', reason: 'MODEL-REASON the same', exception: false }],
    ['global/h.md', { label: 'work', reason: null, exception: true }],
    ['projects/p/f.md', { label: 'general', reason: 'MODEL-REASON a public tool', exception: false }],
  ]);
  const left = new Map([
    ['global/c.md', 'the model call failed (Mantle Responses HTTP 500)'],
    ['projects/p/g.md', 'not sent; the model cost of this run reached its ceiling'],
  ]);
  const exceptions = new Map([['global/b.md', 'personal'], ['global/h.md', 'work'], ['global/gone.md', 'work']]);
  const results = labelResults({ scopes: ['global', 'projects/p'], notes, planned, left, exceptions });
  const asked = { spent: 0.0028, requests: 2, sent: 3, stop: 'ceiling' };
  // As label-plan.json carries it.
  const data = JSON.parse(JSON.stringify(labelPlanData({
    model: 'example-label-model', asked, touched: 4, exceptions: 1, confirmed: 2, results, held: ['global/h.md'],
  })));
  const applied = {
    written: [{ path: 'global/a.md', sha256: '1'.repeat(64) }, { path: 'global/b.md', sha256: '2'.repeat(64) }],
    unchanged: [{ path: 'global/e.md', sha256: '3'.repeat(64) }],
    skipped: [{ path: 'projects/p/f.md', reason: 'changed since it was read' }],
  };
  return { results, asked, data, applied };
}

test('the JSON of the label report counts what label-apply did in each scope, with the figures of the plan', () => {
  const { data, applied } = labelRun();
  assert.doesNotMatch(JSON.stringify(data), /MODEL-REASON|Mantle Responses/);
  const json = labelReportData({ host: 'alpha', date: '2026-11-20', data, ...applied });
  assert.deepEqual(json, {
    schemaVersion: 1, host: 'alpha', kind: 'label', date: '2026-11-20', model: 'example-label-model', stopReason: 'ceiling',
    costUsd: 0.0028, turns: null, denials: null, repaired: null, requests: 2, sent: 3,
    notes: { touched: 4, exceptions: 1, recordedAsTheyWere: 2 },
    written: 2, unchanged: 2, notWritten: 1,
    scopes: [
      {
        scope: 'global', set: 1, changed: 1, unchanged: 2, left: 1, leftReasons: { 'model-call-failed': 1 }, needsRepair: 1,
        unmatchedExceptions: 1, labelsAfter: { work: 3, personal: 2, general: 0, unlabeled: 1 },
      },
      {
        scope: 'projects/p', set: 0, changed: 0, unchanged: 0, left: 2, leftReasons: { ceiling: 1, 'changed-since-read': 1 }, needsRepair: 0,
        unmatchedExceptions: 0, labelsAfter: { work: 0, personal: 0, general: 1, unlabeled: 1 },
      },
    ],
  });
  assert.equal(labelReportData({ host: 'alpha', date: '2026-11-20', data: { ...data, stop: null }, ...applied }).stopReason, 'completed');
  // Without the plan's figures (a plan that has none), only what label-apply knows.
  assert.deepEqual(labelReportData({ host: 'alpha', date: '2026-11-20', data: undefined, ...applied }), {
    schemaVersion: 1, host: 'alpha', kind: 'label', date: '2026-11-20', model: null, stopReason: null,
    costUsd: null, turns: null, denials: null, repaired: null, requests: null, sent: null,
    notes: { touched: null, exceptions: null, recordedAsTheyWere: null },
    written: 2, unchanged: 1, notWritten: 1,
    scopes: [
      { scope: 'global', set: null, changed: null, unchanged: 1, left: 0, leftReasons: {}, needsRepair: null, unmatchedExceptions: null, labelsAfter: null },
      {
        scope: 'projects/p', set: null, changed: null, unchanged: 0, left: 1, leftReasons: { 'changed-since-read': 1 }, needsRepair: null,
        unmatchedExceptions: null, labelsAfter: null,
      },
    ],
  });
  // Figures of the wrong type are not passed on.
  const odd = labelReportData({ host: 'alpha', date: '2026-11-20', data: { model: 7, costUsd: '1', scopes: [{ scope: 'global', labelsAfter: { work: 'x' } }] }, ...applied });
  assert.deepEqual([odd.model, odd.costUsd, odd.scopes[0].labelsAfter], [null, null, null]);
});

test('parseReport reads back the head of a label report', () => {
  const { results, asked, data, applied } = labelRun();
  const text = [
    ...labelReportHead({ date: '2026-11-20', host: 'alpha', model: 'example-label-model', requests: asked.requests, costUsd: asked.spent, touched: 4, sent: asked.sent, exceptions: 1, confirmed: 2 }),
    '', labelReport(results).trimEnd(),
  ].join('\n').concat('\n');
  const json = labelReportData({ host: 'alpha', date: '2026-11-20', data, ...applied });
  // The Markdown holds the head only: the cost in cents, and nothing of what label-apply did.
  assert.deepEqual(parseReport(text), {
    ...json, stopReason: null, costUsd: Number(json.costUsd.toFixed(2)), written: null, unchanged: null, notWritten: null, scopes: null,
  });
});
