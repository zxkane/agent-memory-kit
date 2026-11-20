// The label step's decisions, the same for the notes clone and for the agent scopes: which notes go
// to the model, the batches and the exceptions, when to stop sending them, the record of what the
// step saw, the report, and the lines both passes print about the model calls. No file, Git or
// network access of their own: the model calls and the token come only through the functions they
// are given. A note here is `{ path, scope, digest, domain, name, description, body }`: `digest` is
// what the record keeps for it (the file's SHA-256 in the clone, the object's ETag in the bucket),
// `domain` its label or null, `scope` its folder (`global`, `projects/<name>` or `agents/<agent>`).

import { LABELS, scopeDefault } from './domains.mjs';
import { scanText } from './secret-scan.mjs';

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const scopeOf = (path) => path.slice(0, path.lastIndexOf('/'));

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

// A label token lasts an hour at most: no batch starts once the run's token is this old.
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
// its token, persona and endpoint, giving labelBatch's result. A batch of several notes whose
// answer failed (a refusal, an incomplete answer, two answers that fail the check, another 4xx) is
// split in two halves, its first ⌈n/2⌉ notes and the rest, each sent at once as a batch of its own
// before the next batch, and a half that fails so is split again, down to single notes: batches go
// in the same order every run, and one note that no answer can label must not hold up the others of
// its batch. A batch whose request did not reach the model is never split. Before each request, a
// half's too, it stops when `signal` is aborted (`interrupted`), after FAILURES_IN_A_ROW batches in
// a row whose request did not reach the model (`failures`, a failure: labelBatch marks them
// `transport`), when the cost so far reached `ceiling` USD (`ceiling`, a limit), or when the token,
// made at `tokenAt` (of `now()`, in ms; null when its age is not known), is TOKEN_MAX_AGE_MS old
// (`token-age`, a limit). A failed answer does not stop it: the endpoint answered, which also ends
// a row of failures. Returns the labels given (path -> { label, reason }), the notes not labeled
// (path -> why: those of a failed batch that was not split, and those not sent after a stop),
// `stop` (null when it sent every batch), `failed` (a note was left by a failed request), what it
// spent and requested (split requests included), and how many notes it sent (each once).
export async function sendBatches({ batches, labelBatch, ceiling, now, tokenAt, signal }) {
  const out = { labels: new Map(), left: new Map(), stop: null, failed: false, spent: 0, requests: 0, sent: 0 };
  const leave = (list, why) => list.forEach((b) => b.notes.forEach((n) => out.left.set(n.path, why)));
  const stopBefore = (failures) => {
    if (signal?.aborted) return 'interrupted';
    if (failures >= FAILURES_IN_A_ROW) return 'failures';
    if (out.spent >= ceiling) return 'ceiling';
    if (tokenAt !== null && tokenAt !== undefined && now() - tokenAt >= TOKEN_MAX_AGE_MS) return 'token-age';
    return null;
  };
  // What is still to send, in order: the halves of a split batch go first.
  const queue = batches.map((batch) => ({ batch, half: false }));
  let failures = 0;
  while (queue.length > 0) {
    out.stop = stopBefore(failures);
    if (out.stop) {
      leave(queue.map((q) => q.batch), NOT_SENT[out.stop]);
      break;
    }
    const { batch, half } = queue.shift();
    const res = await labelBatch(batch.notes);
    out.spent += res.costUsd;
    out.requests += res.requests;
    if (!half) out.sent += batch.notes.length;
    if (signal?.aborted) {
      out.stop = 'interrupted';
      leave([batch, ...queue.map((q) => q.batch)], NOT_SENT.interrupted);
      break;
    }
    if (!res.ok) {
      failures = res.transport ? failures + 1 : 0;
      if (!res.transport && batch.notes.length > 1) {
        const cut = Math.ceil(batch.notes.length / 2);
        queue.unshift({ batch: { ...batch, notes: batch.notes.slice(0, cut) }, half: true },
          { batch: { ...batch, notes: batch.notes.slice(cut) }, half: true });
        continue;
      }
      out.failed = true;
      leave([batch], `the model call failed (${res.error})`);
      continue;
    }
    failures = 0;
    for (const n of batch.notes) {
      const answer = res.labels.get(n.id);
      out.labels.set(n.path, { label: answer.label, reason: answer.reason || null });
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

// The model's labels for the batches of a pass (sendBatches), with the run's one token: `token()`
// gives `{ token, tokenAt }` and is called only when there is a batch to send; `labelBatch(notes,
// token)` is the caller's call. A token signed with a role's session lasts an hour, the token-age
// stop's premise; one signed with instance credentials, or read from a token file, may stop
// working earlier, and then its requests fail (401 or 403) until the failure stop ends the pass.
// `line`: what the pass prints about it (why no note was sent, or why it stopped before its last
// batch), or null. A token that cannot be made leaves every note and fails the pass.
export async function askLabelModel({ batches, token, labelBatch, ceiling, now, signal }) {
  const none = { labels: new Map(), left: new Map(), stop: null, failed: false, spent: 0, requests: 0, sent: 0, line: null };
  if (batches.length === 0) return none;
  let run;
  try {
    run = await token();
  } catch (err) {
    const reason = String(err?.message ?? err).split('\n')[0] || 'failed';
    const left = new Map(batches.flatMap((b) => b.notes.map((n) => [n.path, TOKEN_NOT_MADE])));
    return { ...none, left, failed: true, line: `label: the label token could not be made (${reason}); no note was sent to the model.` };
  }
  const asked = await sendBatches({
    batches, ceiling, now, signal, tokenAt: run.tokenAt, labelBatch: (notes) => labelBatch(notes, run.token),
  });
  return { ...asked, line: stopLine(asked.stop, ceiling) };
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
      const now = p ? p.label : n.domain;
      counts[LABELS.includes(now) ? now : 'unlabeled'] += 1;
      if (p && p.label !== n.domain) labels.push({ path: n.path, from: n.domain, to: p.label, reason: p.reason, exception: p.exception });
    }
    return {
      scope,
      labels,
      counts,
      left: mine.filter((n) => left.has(n.path)).map((n) => ({ path: n.path, why: left.get(n.path) })),
      repair: mine.filter((n) => n.skip).map((n) => ({ path: n.path, why: n.skip })),
      unmatched: [...exceptions.keys()].filter((path) => scopeOf(path) === scope && !present.has(path)).sort(byName),
    };
  });
}

// A path or a reason that looks like a credential is not shown.
const shown = (text, what) => (scanText(String(text)).length > 0 ? `(${what} withheld)` : String(text));

// The report of a run: for each scope with something to say, the labels set or changed (old to
// new; with `reasons`, the model's reason), the counts of its labels after the run, the notes left
// for the next run and why, and the exceptions that name no note. '' when no scope has anything.
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
    parts.push(`Labels after this run: ${c.work} work, ${c.personal} personal, ${c.general} general${c.unlabeled > 0 ? `, ${c.unlabeled} unlabeled` : ''}`);
    list('Left for the next run:', r.left.map((l) => `- ${shown(l.path, 'file name')}: ${l.why}`));
    list("Left for Organize's repair:", r.repair.map((l) => `- ${shown(l.path, 'file name')}: ${l.why}`));
    list('Exceptions that name no note:', r.unmatched.map((path) => `- ${shown(path, 'file name')}`));
    sections.push(parts.join('\n\n'));
  }
  return sections.length === 0 ? '' : `${sections.join('\n\n')}\n`;
}
