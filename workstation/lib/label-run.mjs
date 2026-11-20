// The label step's decisions, the same for the notes clone and for the agent scopes: which notes go
// to the model, the batches and the exceptions, the record of what the step saw, and the report.
// Pure functions; no file, Git, network or model. A note here is `{ path, scope, digest, domain,
// name, description, body }`: `digest` is what the record keeps for it (the file's SHA-256 in the
// clone, the object's ETag in the bucket), `domain` its label or null, `scope` its folder
// (`global`, `projects/<name>` or `agents/<agent>`).

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
// note that the run skipped, or whose batch failed, gets no new entry, so it stays touched.
export function nextLabelRecord(record, { present, written = [], unchanged = [], confirmed = [] }) {
  const keep = new Set(present);
  const next = new Map(Object.entries(record ?? {}).filter(([path]) => keep.has(path)));
  for (const { path, digest } of [...confirmed, ...unchanged, ...written]) next.set(path, digest);
  return Object.fromEntries([...next].sort(([a], [b]) => byName(a, b)));
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
