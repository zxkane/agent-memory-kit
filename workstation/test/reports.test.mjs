import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport, labelReportHead } from '../lib/reports.mjs';

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
