import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDomains } from '../lib/domains.mjs';
import {
  FAILURES_IN_A_ROW, LABEL_STOPS, LEFT_WORDS, TOKEN_MAX_AGE_MS, askLabelModel, labelReport, labelResults, leftCategory, nextLabelRecord,
  planLabelBatches, selectTouched, sendBatches, stopLine, unreadScopeResults,
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

// A stand-in for the caller's labelBatch call: the calls whose number (from 1) is in `fails` fail
// as an endpoint out of reach does, those in `noToken` as a call whose token could not be made
// (nothing sent), those in `rejected` as an HTTP 400 does (an answer, not about the notes), those
// in `refused` and those holding a note of `bad` as a refusal does (an answer about the notes);
// the others label every note `work`. An answer costs `cost`, a refusal 0.01, and each call moves
// `clock` on by `step` ms.
function fakeModel({ fails = [], noToken = [], rejected = [], refused = [], bad = [], cost = 0.25, clock = null, step = 0, onCall = () => {} } = {}) {
  const calls = [];
  const labelBatch = async (notes) => {
    calls.push(notes.map((n) => n.path));
    if (clock) clock.ms += step;
    onCall(calls.length);
    if (fails.includes(calls.length)) return { ok: false, error: 'Mantle Responses HTTP 500', transport: true, content: false, costUsd: 0, requests: 1 };
    if (noToken.includes(calls.length)) {
      return { ok: false, error: 'the label token could not be made: 403 AccessDenied', transport: true, content: false, costUsd: 0, requests: 0 };
    }
    if (rejected.includes(calls.length)) return { ok: false, error: 'Mantle Responses HTTP 400', transport: false, content: false, costUsd: 0, requests: 1 };
    if (refused.includes(calls.length) || notes.some((n) => bad.includes(n.path))) {
      return { ok: false, error: 'model refused', transport: false, content: true, costUsd: 0.01, requests: 1 };
    }
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
    'projects/r/n.md': 'not sent; 2 batches in a row failed',
    'projects/s/n.md': 'not sent; 2 batches in a row failed',
  });
});

test('a batch whose token could not be made counts as neither sent nor requested, and toward the failure stop', async () => {
  const model = fakeModel({ noToken: [1] });
  const out = await run(batchesOf('global', 'projects/p', 'projects/q'), model);
  assert.equal(out.stop, null);
  assert.equal(out.failed, true);
  assert.deepEqual([out.sent, out.requests], [2, 2]);
  assert.deepEqual(leftOf(out), { 'global/n.md': 'the model call failed (the label token could not be made: 403 AccessDenied)' });
  // Two in a row stop the pass, with nothing sent.
  const none = await run(batchesOf('global', 'projects/p', 'projects/q'), fakeModel({ noToken: [1, 2] }));
  assert.equal(none.stop, 'failures');
  assert.deepEqual([none.sent, none.requests, none.spent], [0, 0, 0]);
});

test('sendBatches counts only the failures that did not reach the model toward the stop', async () => {
  // Answers that fail (a refusal, an incomplete answer, a 400) say nothing about the endpoint:
  // batches are sent in a fixed order, and two such batches side by side must not stop every run.
  const refused = fakeModel({ refused: [1, 2, 3] });
  const out = await run(batchesOf('global', 'projects/p', 'projects/q', 'projects/r'), refused);
  assert.equal(refused.calls.length, 4);
  assert.equal(out.stop, null);
  assert.equal(out.failed, true);
  assert.deepEqual(leftOf(out), {
    'global/n.md': 'the model call failed (model refused)',
    'projects/p/n.md': 'the model call failed (model refused)',
    'projects/q/n.md': 'the model call failed (model refused)',
  });
  assert.deepEqual([...out.labels.keys()], ['projects/r/n.md']);
  // An answer, even one that fails, ends a row of failures that did not reach the model.
  const between = fakeModel({ fails: [1, 3], refused: [2] });
  assert.equal((await run(batchesOf('global', 'projects/p', 'projects/q', 'projects/r'), between)).stop, null);
  assert.equal(between.calls.length, 4);
  // Two in a row stop it, after a refused batch too.
  const unreachable = fakeModel({ refused: [1], fails: [2, 3] });
  assert.equal((await run(batchesOf('global', 'projects/p', 'projects/q', 'projects/r'), unreachable)).stop, 'failures');
  assert.equal(unreachable.calls.length, 3);
});

test('askLabelModel takes the pass\'s one token source only for a batch, and says why it stopped', async () => {
  const made = [];
  const provideToken = async () => 'example-label-token';
  const tokenSource = async () => { made.push(1); return { provideToken, tokenAt: 0 }; };
  const seen = [];
  const labelBatch = async (notes, given) => { seen.push(given); return { ok: true, labels: new Map(notes.map((n) => [n.id, { label: 'work', reason: 'r' }])), costUsd: 0.6, requests: 1 }; };
  const ask = (batches, extra = {}) => askLabelModel({ batches, tokenSource, labelBatch, ceiling: 1, now: () => 0, ...extra });
  // No batch, no token source.
  assert.deepEqual(await ask([]), { labels: new Map(), left: new Map(), stop: null, failed: false, spent: 0, requests: 0, sent: 0, line: null });
  assert.equal(made.length, 0);
  // One token source for every batch of the pass, whose calls take its tokens; the second batch reaches the ceiling.
  const out = await ask(batchesOf('global', 'projects/p', 'projects/q'));
  assert.equal(made.length, 1);
  assert.deepEqual(seen, [provideToken, provideToken]);
  assert.equal(out.stop, 'ceiling');
  assert.equal(out.line, 'label: stopped; the model cost of this run reached its ceiling of USD 1.00');
  // A token file's age counts from when the source says its token was issued, not from when the pass took it.
  const old = await ask(batchesOf('global'), { now: () => TOKEN_MAX_AGE_MS });
  assert.equal(old.stop, 'token-age');
  assert.equal(old.sent, 0);
  assert.equal(old.line, 'label: stopped; the label token of this run is near the end of its hour');
  // A source whose tokens have no age (a provider that makes one for each request) never stops for it.
  const fresh = await askLabelModel({
    batches: batchesOf('global'), tokenSource: async () => ({ provideToken, tokenAt: null }), labelBatch, ceiling: 1, now: () => 10 * TOKEN_MAX_AGE_MS,
  });
  assert.deepEqual([fresh.stop, fresh.sent], [null, 1]);
  // A token source that cannot be made leaves every note of every batch, and fails the pass.
  const broken = await askLabelModel({
    batches: batchesOf('global', 'projects/p'), tokenSource: async () => { throw new Error('the label token file is not a token\nmore'); },
    labelBatch, ceiling: 1, now: () => 0,
  });
  assert.equal(broken.failed, true);
  assert.equal(broken.line, 'label: the label token could not be made (the label token file is not a token); no note was sent to the model.');
  assert.deepEqual(leftOf(broken), { 'global/n.md': 'not sent; the label token could not be made', 'projects/p/n.md': 'not sent; the label token could not be made' });
  // The stop lines, the same for every pass.
  assert.equal(stopLine('failures', 1), `label: stopped; ${FAILURES_IN_A_ROW} batches in a row failed`);
  assert.equal(stopLine('interrupted', 1), null);
  assert.equal(stopLine(null, 1), null);
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

// One batch of the notes `names` of a scope, as planLabelBatches gives it.
const batchOf = (scope, names) => ({
  scope, notes: names.map((x, i) => ({ ...note(`${scope}/${x}.md`), id: `n${String(i + 1).padStart(3, '0')}`, default: 'general' })),
});
const pathsIn = (scope, names) => names.map((x) => `${scope}/${x}.md`);

test('sendBatches splits a batch that fails for a content reason, down to the note that fails it', async () => {
  // One note that no answer can label must not hold up the 18 others of its batch, run after run.
  const names = Array.from({ length: 19 }, (_, i) => `n${String(i + 1).padStart(2, '0')}`);
  const model = fakeModel({ bad: ['global/n07.md'] });
  const out = await run([batchOf('global', names), ...batchesOf('projects/p')], model);
  const span = (from, to) => pathsIn('global', names.slice(from - 1, to));
  // The halves of a failed batch go at once, before the next batch: the first ⌈n/2⌉ notes, then the
  // rest; the half that failed alone is split in turn.
  assert.deepEqual(model.calls, [
    span(1, 19), span(1, 10), span(11, 19), span(1, 5), span(6, 10), span(6, 8), span(9, 10), span(6, 7), span(8, 8), span(6, 6),
    span(7, 7), ['projects/p/n.md'],
  ]);
  assert.deepEqual(leftOf(out), { 'global/n07.md': 'the model call failed (model refused)' });
  assert.equal(out.labels.size, 19);
  assert.equal(out.labels.has('global/n07.md'), false);
  assert.equal(out.stop, null);
  assert.equal(out.failed, true, 'a note is left by a failed request');
  // Every request counts, the split ones too; a note counts once among those sent.
  assert.deepEqual([out.requests, out.sent], [12, 20]);
  assert.equal(out.spent.toFixed(2), '1.56');
});

test('a batch whose halves are all answered does not fail the run', async () => {
  const model = fakeModel({ refused: [1] });
  const out = await run([batchOf('global', ['a', 'b', 'c'])], model);
  assert.deepEqual(model.calls, [pathsIn('global', ['a', 'b', 'c']), pathsIn('global', ['a', 'b']), pathsIn('global', ['c'])]);
  assert.equal(out.failed, false);
  assert.equal(out.stop, null);
  assert.deepEqual(leftOf(out), {});
  assert.deepEqual([...out.labels.keys()], pathsIn('global', ['a', 'b', 'c']));
  assert.deepEqual([out.requests, out.sent], [3, 3]);
});

test('a batch that does not reach the model is never split', async () => {
  const model = fakeModel({ fails: [1] });
  const out = await run([batchOf('global', ['a', 'b', 'c']), ...batchesOf('projects/p')], model);
  assert.deepEqual(model.calls, [pathsIn('global', ['a', 'b', 'c']), ['projects/p/n.md']]);
  assert.equal(out.failed, true);
  const failed = 'the model call failed (Mantle Responses HTTP 500)';
  assert.deepEqual(leftOf(out), { 'global/a.md': failed, 'global/b.md': failed, 'global/c.md': failed });
  // The halves of a split batch count toward the failure stop as any batch does.
  const halves = fakeModel({ refused: [1], fails: [2, 3] });
  const stopped = await run([batchOf('global', ['a', 'b', 'c', 'd']), ...batchesOf('projects/p')], halves);
  assert.deepEqual(halves.calls, [pathsIn('global', ['a', 'b', 'c', 'd']), pathsIn('global', ['a', 'b']), pathsIn('global', ['c', 'd'])]);
  assert.equal(stopped.stop, 'failures');
  assert.equal(stopped.failed, true);
  assert.equal(leftOf(stopped)['global/a.md'], failed);
  assert.equal(leftOf(stopped)['projects/p/n.md'], 'not sent; 2 batches in a row failed');
});

test('only an answer about the notes splits a batch: an HTTP error on every request costs one request per batch', async () => {
  // A wrong model or parameter fails every request at once, unbilled: splitting would cost 2n - 1
  // requests per batch with no ceiling to stop them.
  const model = fakeModel({ rejected: [1, 2, 3] });
  const out = await run([batchOf('global', ['a', 'b', 'c']), batchOf('projects/p', ['d', 'e']), ...batchesOf('projects/q')], model);
  assert.deepEqual(model.calls, [pathsIn('global', ['a', 'b', 'c']), pathsIn('projects/p', ['d', 'e']), ['projects/q/n.md']]);
  assert.equal(out.requests, 3);
  assert.equal(out.stop, null, 'the endpoint answered');
  assert.equal(out.failed, true);
  const why = 'the model call failed (Mantle Responses HTTP 400)';
  assert.deepEqual(leftOf(out), {
    'global/a.md': why, 'global/b.md': why, 'global/c.md': why, 'projects/p/d.md': why, 'projects/p/e.md': why, 'projects/q/n.md': why,
  });
});

test('when both halves of a split fail, their notes stay touched and the run splits no more', async () => {
  // Two halves that both fail say the batch failed as a whole, not one note of it.
  const model = fakeModel({ bad: ['global/a.md', 'global/c.md', 'projects/p/e.md'] });
  const out = await run([batchOf('global', ['a', 'b', 'c', 'd']), batchOf('projects/p', ['e', 'f'])], model);
  assert.deepEqual(model.calls, [
    pathsIn('global', ['a', 'b', 'c', 'd']), pathsIn('global', ['a', 'b']), pathsIn('global', ['c', 'd']), pathsIn('projects/p', ['e', 'f']),
  ]);
  const why = 'the model call failed (model refused)';
  assert.deepEqual(leftOf(out), Object.fromEntries([...pathsIn('global', ['a', 'b', 'c', 'd']), ...pathsIn('projects/p', ['e', 'f'])].map((p) => [p, why])));
  assert.equal(out.failed, true);
  assert.deepEqual([out.requests, out.sent], [4, 6]);
  // A half that fails while the other is answered is still split, down to the note.
  const one = fakeModel({ bad: ['global/d.md'] });
  const alone = await run([batchOf('global', ['a', 'b', 'c', 'd'])], one);
  assert.deepEqual(one.calls, [
    pathsIn('global', ['a', 'b', 'c', 'd']), pathsIn('global', ['a', 'b']), pathsIn('global', ['c', 'd']), ['global/c.md'], ['global/d.md'],
  ]);
  assert.deepEqual(leftOf(alone), { 'global/d.md': why });
});

test('the ceiling, the token age and the signal apply before every half of a split batch', async () => {
  const four = () => batchOf('global', ['a', 'b', 'c', 'd']);
  // The first half reaches the ceiling: the second half and the next batch are not sent.
  const priced = fakeModel({ bad: ['global/d.md'], cost: 0.6 });
  const out = await run([four(), ...batchesOf('projects/p')], priced, { ceiling: 0.6 });
  assert.deepEqual(priced.calls, [pathsIn('global', ['a', 'b', 'c', 'd']), pathsIn('global', ['a', 'b'])]);
  assert.equal(out.stop, 'ceiling');
  assert.equal(out.failed, false, 'no note is left by a failed request');
  const ceiling = 'not sent; the model cost of this run reached its ceiling';
  assert.deepEqual(leftOf(out), { 'global/c.md': ceiling, 'global/d.md': ceiling, 'projects/p/n.md': ceiling });
  assert.deepEqual([...out.labels.keys()], pathsIn('global', ['a', 'b']));
  // Each request takes 30 minutes: the second half would start with a token an hour old.
  const clock = { ms: 0 };
  const slow = fakeModel({ bad: ['global/d.md'], clock, step: 30 * 60 * 1000 });
  const aged = await run([four()], slow, { now: () => clock.ms, tokenAt: 0 });
  assert.equal(slow.calls.length, 2);
  assert.equal(aged.stop, 'token-age');
  assert.deepEqual(Object.keys(leftOf(aged)), pathsIn('global', ['c', 'd']));
  // A signal during the failed request: no half is sent.
  const abort = new AbortController();
  const stopped = fakeModel({ bad: ['global/d.md'], onCall: () => abort.abort() });
  const cut = await run([four()], stopped, { signal: abort.signal });
  assert.equal(stopped.calls.length, 1);
  assert.equal(cut.stop, 'interrupted');
  assert.deepEqual(Object.keys(leftOf(cut)), pathsIn('global', ['a', 'b', 'c', 'd']));
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

test('a run over every scope also names the exceptions of the scopes it did not read', () => {
  // A name in the domains file that is not a folder or an agent scope (a typo) is never applied.
  const exceptions = new Map([
    ['global/a.md', 'work'], ['projects/typo/y.md', 'personal'], ['projects/typo/x.md', 'work'], ['projects/p/gone.md', 'work'],
    ['agents/nobody/z.md', 'general'], ['projects/other/w.md', 'work'],
  ]);
  const clone = (scope) => scope === 'global' || scope.startsWith('projects/');
  const results = unreadScopeResults({ scopes: ['global', 'projects/p'], exceptions, own: clone });
  assert.deepEqual(results, [
    { scope: 'projects/other', labels: [], counts: null, left: [], repair: [], unmatched: ['projects/other/w.md'] },
    { scope: 'projects/typo', labels: [], counts: null, left: [], repair: [], unmatched: ['projects/typo/x.md', 'projects/typo/y.md'] },
  ]);
  // Each pass names its own scopes only.
  const agents = unreadScopeResults({ scopes: ['agents/example-agent'], exceptions, own: (scope) => scope.startsWith('agents/') });
  assert.deepEqual(agents.map((r) => [r.scope, r.unmatched]), [['agents/nobody', ['agents/nobody/z.md']]]);
  // The report lists them under their scope, without counts for a scope that was not read.
  assert.equal(labelReport(results), [
    '## projects/other', '', 'Exceptions that name no note:', '- projects/other/w.md', '',
    '## projects/typo', '', 'Exceptions that name no note:', '- projects/typo/x.md', '- projects/typo/y.md', '',
  ].join('\n'));
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

test('leftCategory names why a note was left with a fixed word, never with the text of an error', async () => {
  // The reasons sendBatches and askLabelModel give.
  const stopped = async (extra, model = fakeModel()) => Object.values(Object.fromEntries((await run(batchesOf('global', 'projects/p'), model, extra)).left));
  assert.deepEqual((await stopped({ ceiling: 0 })).map(leftCategory), ['ceiling', 'ceiling']);
  assert.deepEqual((await stopped({ now: () => TOKEN_MAX_AGE_MS, tokenAt: 0 })).map(leftCategory), ['token-age', 'token-age']);
  assert.deepEqual((await stopped({}, fakeModel({ fails: [1, 2] }))).map(leftCategory), ['model-call-failed', 'model-call-failed']);
  const abort = new AbortController();
  abort.abort();
  assert.deepEqual((await stopped({ signal: abort.signal })).map(leftCategory), ['interrupted', 'interrupted']);
  const failures = await run(batchesOf('global', 'projects/p', 'projects/q'), fakeModel({ fails: [1, 2] }));
  assert.equal(leftCategory(failures.left.get('projects/q/n.md')), 'failures');
  const noToken = await askLabelModel({
    batches: batchesOf('global'), tokenSource: async () => { throw new Error('no token'); }, labelBatch: fakeModel().labelBatch, ceiling: 5, now: () => 0,
  });
  assert.equal(leftCategory(noToken.left.get('global/n.md')), 'token-not-made');
  // The reasons label-apply and the frontmatter give a note it does not write.
  const skips = ['gone', 'changed since it was read', 'not UTF-8 text', 'no frontmatter', 'frontmatter not closed', 'metadata is not a block'];
  assert.deepEqual(skips.map(leftCategory), ['gone', 'changed-since-read', 'not-utf8', 'frontmatter', 'frontmatter', 'frontmatter']);
  assert.equal(leftCategory('anything else (with a detail)'), 'other');
  // The lists the report checks a twin's words against.
  assert.deepEqual(LEFT_WORDS, [
    'interrupted', 'failures', 'ceiling', 'token-age', 'token-not-made', 'model-call-failed', 'gone', 'changed-since-read', 'not-utf8',
    'frontmatter', 'other',
  ]);
  assert.deepEqual(LABEL_STOPS, ['completed', 'failures', 'ceiling', 'token-age']);
});
