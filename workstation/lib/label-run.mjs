// The label step's decisions, the same for the notes clone and for the agent scopes: which notes go
// to the model, the batches and the exceptions, when to stop sending them, the record of what the
// step saw, the report, and the lines both passes print about the model calls. No file, Git or
// network access of their own: the model calls and the token come only through the functions they
// are given. A note here is `{ path, scope, digest, domain, name, description, body }`: `digest` is
// what the record keeps for it (the file's SHA-256 in the clone, the object's ETag in the bucket),
// `domain` its label or null, `scope` its folder (`global`, `projects/<name>` or `agents/<agent>`).

import { dirname } from 'node:path';
import { LABELS, scopeDefault } from './domains.mjs';
import { scanText } from './secret-scan.mjs';

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// What an error may print, never a response body: the first line of its message, or `failed`. An
// AwsError or AgentScopeError message is one fixed line (an operation, a status and a code, or a
// fixed text), so it is printed whole.
export const errorText = (err) => String(err?.message ?? err).split('\n')[0] || 'failed';

// The notes to send to the model. With `all`, every note. Without a record (the first run), the
// notes without a label; those with one are `confirmed`, recorded as they are. Otherwise the notes
// whose digest is not the one recorded for them, which includes those never recorded.
export function selectTouched({ notes, record, all }) {
  if (all) return { touched: [...notes], confirmed: [] };
  if (record === null || record === undefined) {
    const labeled = (n) => LABELS.includes(n.domain);
    return {
      touched: notes.filter((n) => !labeled(n)),
      confirmed: notes.filter(labeled).map((n) => ({ path: n.path, digest: n.digest })),
    };
  }
  return { touched: notes.filter((n) => !(Object.hasOwn(record, n.path) && record[n.path] === n.digest)), confirmed: [] };
}

// The exceptions and the batches of a run. `exceptions`: every note of `notes` that the domains
// file names, touched or not, with the exception's label: code applies them on every run.
// `batches`: the touched notes without an exception, one scope per batch and at most `batchNotes`
// notes in each, in the order given. Each note of a batch keeps its fields and gets the id the
// prompt gives it (`n001`, ...) and its scope's default label.
export function planLabelBatches({ notes, touched, domains, batchNotes }) {
  const exceptions = notes.filter((n) => domains.exceptions.has(n.path))
    .map((n) => ({ path: n.path, label: domains.exceptions.get(n.path), digest: n.digest }));
  const byScope = new Map();
  for (const n of touched) {
    if (domains.exceptions.has(n.path)) continue;
    if (!byScope.has(n.scope)) byScope.set(n.scope, []);
    byScope.get(n.scope).push(n);
  }
  const batches = [];
  for (const [scope, list] of byScope) {
    const fallback = scopeDefault(domains, scope);
    for (let i = 0; i < list.length; i += batchNotes) {
      const notesOfBatch = list.slice(i, i + batchNotes)
        .map((n, j) => ({ ...n, id: `n${String(j + 1).padStart(3, '0')}`, default: fallback }));
      batches.push({ scope, notes: notesOfBatch });
    }
  }
  return { exceptions, batches };
}

// The record after a run, sorted by path: the old entries of the notes still `present`, then the
// notes the run recorded, each `{ path, digest }`: `confirmed` (labeled notes found on a first
// run), `unchanged` (the label was already the one given) and `written`, a later list winning. A
// note that the run skipped, or whose batch failed, gets no new entry, so it stays touched. `left`
// (paths) are the notes the run took but did not record: they lose their old entry too, which
// still matches them after an `--all` run, so that the next run sends them.
export function nextLabelRecord(record, { present, written = [], unchanged = [], confirmed = [], left = [] }) {
  const keep = new Set(present);
  for (const path of left) keep.delete(path);
  const next = new Map(Object.entries(record ?? {}).filter(([path]) => keep.has(path)));
  for (const { path, digest } of [...confirmed, ...unchanged, ...written]) next.set(path, digest);
  return Object.fromEntries([...next].sort(([a], [b]) => byName(a, b)));
}

// A token from a token file lasts an hour at most: no batch starts once it is this old. A token of
// the token generator is made for each request, so it has no age.
export const TOKEN_MAX_AGE_MS = 55 * 60 * 1000;
// After this many batches in a row that did not reach the model, the endpoint is taken as out of reach.
export const FAILURES_IN_A_ROW = 2;

// Why the notes of the batches after a stop were not sent.
const NOT_SENT = {
  interrupted: 'not sent; the run was interrupted',
  failures: `not sent; ${FAILURES_IN_A_ROW} batches in a row failed`,
  ceiling: 'not sent; the model cost of this run reached its ceiling',
  'token-age': 'not sent; the label token of this run was near the end of its hour',
};
const TOKEN_NOT_MADE = 'not sent; the label token could not be made';

// Sends the batches to the model in order, one `labelBatch(notes)` each: the caller's call, with
// its token source, persona and endpoint, giving labelBatch's result. A batch of several notes whose
// answer was about its notes and failed (`content`: a refusal, an incomplete answer, two answers
// that fail the check) is split in two halves, its first ⌈n/2⌉ notes and the rest, both sent at
// once as batches of their own before the next batch: batches go in the same order every run, and
// one note that no answer can label must not hold up the others of its batch. When only one half
// fails, it is settled the same way (split again if its answer was about its notes, down to single
// notes, otherwise left). When both halves fail, the batch failed as a whole: their notes are left
// with their reasons, and no batch of the run is split again. A failure that is not about the notes
// (an HTTP error status, an answer that is not JSON or is too large, an abort, a request that did
// not reach the model) never splits: a wrong model or parameter fails every request at once,
// unbilled, and splitting would multiply them. Before each request, a half's too, it stops when
// `signal` is aborted (`interrupted`), after FAILURES_IN_A_ROW batches in a row whose request did
// not reach the model (`failures`, a failure: labelBatch marks them `transport`, also when no token
// could be made for them), when the cost so far reached `ceiling` USD (`ceiling`, a limit), or when
// the token, made at `tokenAt` (of `now()`, in ms; null when it has no known age), is
// TOKEN_MAX_AGE_MS old (`token-age`, a limit). Any other
// failure does not stop it: the endpoint answered, which also ends a row of failures. Returns the
// labels given (path -> { label, reason }), the notes not labeled (path -> why: those of a failed
// batch that was not split, and those not sent after a stop), `stop` (null when it sent every
// batch), `failed` (a note was left by a failed request), what it spent and requested (split
// requests included), and how many notes it sent (each once).
export async function sendBatches({ batches, labelBatch, ceiling, now, tokenAt, signal }) {
  const out = { labels: new Map(), left: new Map(), stop: null, failed: false, spent: 0, requests: 0, sent: 0 };
  const leave = (list, why) => list.forEach((b) => b.notes.forEach((n) => out.left.set(n.path, why)));
  const leaveFailed = (batch, res) => {
    out.failed = true;
    leave([batch], `the model call failed (${res.error})`);
  };
  let failures = 0;
  let splitting = true;
  const stopBefore = () => {
    if (signal?.aborted) return 'interrupted';
    if (failures >= FAILURES_IN_A_ROW) return 'failures';
    if (out.spent >= ceiling) return 'ceiling';
    if (tokenAt !== null && tokenAt !== undefined && now() - tokenAt >= TOKEN_MAX_AGE_MS) return 'token-age';
    return null;
  };
  // One request: labelBatch's result, its labels kept when it succeeded, or null when the run
  // stopped before or during it (its notes are left with the stop's reason).
  const send = async (batch, { half }) => {
    out.stop = stopBefore();
    if (out.stop) {
      leave([batch], NOT_SENT[out.stop]);
      return null;
    }
    const res = await labelBatch(batch.notes);
    out.spent += res.costUsd;
    out.requests += res.requests;
    if (!half) out.sent += batch.notes.length;
    if (signal?.aborted) {
      out.stop = 'interrupted';
      leave([batch], NOT_SENT.interrupted);
      return null;
    }
    if (!res.ok) {
      failures = res.transport ? failures + 1 : 0;
      return res;
    }
    failures = 0;
    for (const n of batch.notes) {
      const answer = res.labels.get(n.id);
      out.labels.set(n.path, { label: answer.label, reason: answer.reason || null });
    }
    return res;
  };
  // A failed batch: split when its answer was about its notes, otherwise left.
  const settle = async (batch, res) => {
    if (splitting && res.content === true && batch.notes.length > 1) await split(batch);
    else leaveFailed(batch, res);
  };
  // Sends both halves of `batch`, then settles the one that failed alone; when both failed, the run
  // splits no more.
  const split = async (batch) => {
    const cut = Math.ceil(batch.notes.length / 2);
    const halves = [{ ...batch, notes: batch.notes.slice(0, cut) }, { ...batch, notes: batch.notes.slice(cut) }];
    const results = [];
    for (const half of halves) {
      if (out.stop === null) {
        results.push(await send(half, { half: true }));
      } else {
        leave([half], NOT_SENT[out.stop]);
        results.push(null);
      }
    }
    const failed = halves.map((half, i) => [half, results[i]]).filter(([, res]) => res !== null && !res.ok);
    if (out.stop) {
      for (const [half, res] of failed) leaveFailed(half, res);
    } else if (failed.length === 2) {
      splitting = false;
      for (const [half, res] of failed) leaveFailed(half, res);
    } else if (failed.length === 1) {
      await settle(...failed[0]);
    }
  };
  for (const [i, batch] of batches.entries()) {
    const res = await send(batch, { half: false });
    if (res !== null && !res.ok) await settle(batch, res);
    if (out.stop) {
      leave(batches.slice(i + 1), NOT_SENT[out.stop]);
      break;
    }
  }
  return out;
}

// The line a pass prints when sendBatches stopped before its last batch; null for no stop, and for
// an interruption, which the run reports itself.
export function stopLine(stop, ceiling) {
  if (stop === 'failures') return `label: stopped; ${FAILURES_IN_A_ROW} batches in a row failed`;
  if (stop === 'ceiling') return `label: stopped; the model cost of this run reached its ceiling of USD ${ceiling.toFixed(2)}`;
  if (stop === 'token-age') return 'label: stopped; the label token of this run is near the end of its hour';
  return null;
}

// The model's labels for the batches of a pass (sendBatches), with the pass's one token source:
// `tokenSource()` gives `{ provideToken, tokenAt }` and is called only when there is a batch to
// send; `labelBatch(notes, provideToken)` is the caller's call, which awaits `provideToken()` before
// each of its requests. A token file's token may stop working before the token-age stop, and then
// its requests fail (401 or 403) until the failure stop ends the pass; a token that cannot be made
// for a request fails that request as one that did not reach the model. `line`: what the pass
// prints about it (why no note was sent, or why it stopped before its last batch), or null. A
// token source that cannot be made (a token file that is not a token, packages that are not
// installed) leaves every note and fails the pass.
export async function askLabelModel({ batches, tokenSource, labelBatch, ceiling, now, signal }) {
  const none = { labels: new Map(), left: new Map(), stop: null, failed: false, spent: 0, requests: 0, sent: 0, line: null };
  if (batches.length === 0) return none;
  let run;
  try {
    run = await tokenSource();
  } catch (err) {
    const reason = errorText(err);
    const left = new Map(batches.flatMap((b) => b.notes.map((n) => [n.path, TOKEN_NOT_MADE])));
    return { ...none, left, failed: true, line: `label: the label token could not be made (${reason}); no note was sent to the model.` };
  }
  const asked = await sendBatches({
    batches, ceiling, now, signal, tokenAt: run.tokenAt, labelBatch: (notes) => labelBatch(notes, run.provideToken),
  });
  return { ...asked, line: stopLine(asked.stop, ceiling) };
}

// The labels a run gives, path -> { label, reason, exception }: the `exceptions` of the domains file
// (planLabelBatches' list) and the labels the model gave (`labels`, path -> { label, reason }).
export function plannedLabels(exceptions, labels) {
  return new Map([
    ...exceptions.map((e) => [e.path, { label: e.label, reason: null, exception: true }]),
    ...[...labels].map(([path, given]) => [path, { ...given, exception: false }]),
  ]);
}

// What a run did in each of its `scopes` (folder names, in order), for labelReport.
// - `notes`: every present note of those scopes, with `skip` (why setDomain cannot label it) or null;
// - `planned`: path -> { label, reason, exception }, the labels the run gives;
// - `left`: path -> why, the notes it leaves for the next run;
// - `exceptions`: the domains file's exceptions (path -> label); those of the run's scopes that
//   name none of its notes are listed.
export function labelResults({ scopes, notes, planned, left, exceptions }) {
  const present = new Set(notes.map((n) => n.path));
  return scopes.map((scope) => {
    const mine = notes.filter((n) => n.scope === scope);
    const counts = { work: 0, personal: 0, general: 0, unlabeled: 0 };
    const labels = [];
    for (const n of mine) {
      const p = planned.get(n.path);
      const after = p ? p.label : n.domain;
      counts[LABELS.includes(after) ? after : 'unlabeled'] += 1;
      if (p && p.label !== n.domain) labels.push({ path: n.path, from: n.domain, to: p.label, reason: p.reason, exception: p.exception });
    }
    return {
      scope,
      labels,
      counts,
      left: mine.filter((n) => left.has(n.path)).map((n) => ({ path: n.path, why: left.get(n.path) })),
      repair: mine.filter((n) => n.skip).map((n) => ({ path: n.path, why: n.skip })),
      unmatched: [...exceptions.keys()].filter((path) => dirname(path) === scope && !present.has(path)).sort(byName),
    };
  });
}

// For a run over every scope: one result per scope that the domains file's `exceptions` name, that
// is one of the pass's own (`own(scope)`), and that the run did not read (not among `scopes`): a
// project folder, or an agent scope, that does not exist, often a typo. Its exceptions are listed as
// naming no note; it has no counts.
export function unreadScopeResults({ scopes, exceptions, own }) {
  const read = new Set(scopes);
  const unread = new Map();
  for (const path of [...exceptions.keys()].sort(byName)) {
    const scope = dirname(path);
    if (read.has(scope) || !own(scope)) continue;
    if (!unread.has(scope)) unread.set(scope, []);
    unread.get(scope).push(path);
  }
  return [...unread].sort(([a], [b]) => byName(a, b))
    .map(([scope, unmatched]) => ({ scope, labels: [], counts: null, left: [], repair: [], unmatched }));
}

// A path or a reason that looks like a credential is not shown.
const shown = (text, what) => (scanText(String(text)).length > 0 ? `(${what} withheld)` : String(text));

// The report of a run: for each scope with something to say, the labels set or changed (old to
// new; with `reasons`, the model's reason), the counts of its labels after the run (none for a
// scope the run did not read), the notes left for the next run and why, and the exceptions that
// name no note. '' when no scope has anything.
export function labelReport(results, { reasons = true } = {}) {
  const sections = [];
  for (const r of results) {
    if (r.labels.length + r.left.length + r.repair.length + r.unmatched.length === 0) continue;
    const parts = [`## ${r.scope}`];
    const list = (heading, items) => {
      if (items.length > 0) parts.push([heading, ...items].join('\n'));
    };
    list('Labels set or changed:', r.labels.map((l) => {
      let line = `- ${shown(l.path, 'file name')}: ${l.from ?? 'unlabeled'} → ${l.to}`;
      if (l.exception) line += ' (exception)';
      else if (reasons && l.reason) line += ` — ${shown(l.reason, 'reason')}`;
      return line;
    }));
    const c = r.counts;
    if (c !== null) parts.push(`Labels after this run: ${c.work} work, ${c.personal} personal, ${c.general} general${c.unlabeled > 0 ? `, ${c.unlabeled} unlabeled` : ''}`);
    list('Left for the next run:', r.left.map((l) => `- ${shown(l.path, 'file name')}: ${l.why}`));
    list("Left for Organize's repair:", r.repair.map((l) => `- ${shown(l.path, 'file name')}: ${l.why}`));
    list('Exceptions that name no note:', r.unmatched.map((path) => `- ${shown(path, 'file name')}`));
    sections.push(parts.join('\n\n'));
  }
  return sections.length === 0 ? '' : `${sections.join('\n\n')}\n`;
}
