// The reports of consolidation: `_reports/<date>-<host>-<kind>-<scope>.md` of an Extract or
// Organize scope that was applied, and `_reports/<date>-<host>-label.md` of the label step (a later
// run of the same day adds `-2`, `-3` and so on to the name), which the run commits to the notes
// clone with its changes. Each has a JSON twin of the same name
// (`.json`), rendered from the same figures, for programs: the Markdown is for people and its form
// is the kit's own. parseReport reads the Markdown of a report back, for one that an older kit
// wrote without its twin. No file, Git or network access of its own.

import { dirname } from 'node:path';
import { leftCategory } from './label-run.mjs';
import { GLOBAL, scopeFolder } from './scopes.mjs';
import { scanText } from './secret-scan.mjs';

// The version of the JSON reports' form. It changes only with a change that breaks a reader.
export const REPORT_SCHEMA_VERSION = 1;
// The kinds of a twin's changes.
export const CHANGE_KINDS = Object.freeze(['add', 'change', 'retire']);
// The file of a report: its date, the rest of its name, and `.md` or `.json`.
export const REPORT_NAME_RE = /^(\d{4}-\d\d-\d\d)-.+\.(md|json)$/;

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// An amount in USD as every line of the kit shows it: two decimals, or `unknown`.
export const usd = (value) => `USD ${value === null || value === undefined ? 'unknown' : value.toFixed(2)}`;

// What output and reports show instead of a name that looks like a credential.
export const WITHHELD = '(file name withheld)';

// A name shown in output or in a report; one that looks like a credential is not shown.
export function shown(text) {
  return scanText(String(text)).length > 0 ? WITHHELD : String(text);
}

// `<label>/<file>` (as evaluate names it) shown relative to the scope: global/ keeps its prefix.
function display(label, file) {
  return label === GLOBAL ? `global/${file}` : file;
}

function splitLoc(entry) {
  const slash = entry.indexOf('/');
  return slash < 0 ? { label: 'notes', file: entry } : { label: entry.slice(0, slash), file: entry.slice(slash + 1) };
}

// The report of an Extract or Organize scope: the model's figures, what reached it (Extract), the
// index and note sizes of each folder before and after, the share of distinct terms kept, and the
// notes added (with their descriptions), changed, retired and not applied. `pairs` are the scope's
// folders (`notes`, and `global` in a project run), `snap` the snapshot, `ev` what evaluate said.
export function buildReport({ config, kind, scope, date, model, stopReason, costUsd, turns, denials, pairs, snap, ev, descriptions, conversation, repaired = 0 }) {
  const title = `${kind[0].toUpperCase()}${kind.slice(1)}`;
  const suffix = (label) => (label === GLOBAL ? ' (global/)' : '');
  const changed = (label) => ev.changes.some((c) => c.label === label);
  const labels = pairs.map((p) => p.label);
  const shownLabels = labels.filter((l) => l === 'notes' || changed(l));
  const lines = [`# ${title} ${scope} — ${date} on ${config.host}`, ''];
  lines.push(`- Model: ${model}; turns: ${turns ?? 'unknown'}; cost: ${usd(costUsd)}; stopped: ${stopReason}; denials: ${denials ?? 'unknown'}`);
  if (repaired > 0) lines.push(`- Repair: one repair run; the first check found ${repaired} problem(s)`);
  if (conversation) {
    lines.push(conversation.truncated
      ? `- Conversation text: cut to ${conversation.bytes} bytes; ${conversation.sessionsLeftOut} session(s) left out`
      : '- Conversation text: complete');
  }
  for (const l of shownLabels) {
    const { indexBefore: b, indexAfter: a } = ev.stats[l];
    lines.push(`- Index${suffix(l)}: ${b.lines} lines, ${b.bytes} bytes → ${a.lines} lines, ${a.bytes} bytes`);
  }
  for (const l of shownLabels) {
    lines.push(`- Notes not listed in the index${suffix(l)}: ${ev.stats[l].unlistedBefore} → ${ev.stats[l].unlistedAfter}`);
  }
  for (const l of labels.filter(changed)) {
    const s = ev.stats[l];
    lines.push(`- Notes${suffix(l)}: ${s.notesBytesBefore} bytes → ${s.notesBytesAfter} bytes; retired: ${s.retiredBytes} bytes`);
  }
  const r = ev.stats.retention;
  lines.push(`- Distinct terms kept: ${Math.floor(r.share * 100)}% (${r.termsKept} of ${r.termsBefore})`);
  const order = (c) => `${labels.indexOf(c.label)}\u0000${c.file}`;
  const sorted = [...ev.changes].sort((x, y) => byName(order(x), order(y)));
  let first = true;
  const section = (heading, items) => {
    if (items.length === 0) return;
    if (first) lines.push('');
    first = false;
    lines.push(`## ${heading}`, ...items);
  };
  section('Added', sorted.filter((c) => c.kind === 'add')
    .map((c) => `- ${shown(display(c.label, c.file))} — ${descriptions.get(`${c.label}/${c.file}`) ?? '(no description)'}`));
  section('Changed', sorted.filter((c) => c.kind === 'change').map((c) => `- ${shown(display(c.label, c.file))}`));
  section('Retired', sorted.filter((c) => c.kind === 'retire')
    .map((c) => `- ${shown(display(c.label, c.file))} → ${shown(display(c.target.label, c.target.file))}`));
  // Entries that are not notes at all are counted per folder, never named.
  const notNotes = labels.filter((l) => ev.ignoredEntries?.[l] > 0).map((l) => {
    const n = ev.ignoredEntries[l];
    const what = n === 1 ? '1 entry that is not a note file' : `${n} entries that are not note files`;
    return `- ${l === GLOBAL ? 'global/' : ''}(${what}): ignored`;
  });
  section('Not applied', [...ev.ignored.map((entry) => {
    const { label, file } = splitLoc(entry);
    const known = snap[label] && Object.hasOwn(snap[label], file);
    const why = known ? 'retiring a note is not part of an extract run' : 'a new file cannot be a retirement';
    return `- ${display(label, file)}: ${why}`;
  }), ...notNotes]);
  return `${lines.join('\n')}\n`;
}

// The head of the label step's report: its title, the model's figures and what the step did with
// the notes. The scope sections (labelReport in label-run.mjs) follow it.
export function labelReportHead({ date, host, model, requests, costUsd, touched, sent, exceptions, confirmed }) {
  return [
    `# Labels — ${date} on ${host}`, '',
    `- Model: ${model}; requests: ${requests}; cost: ${usd(costUsd)}`,
    `- Notes: ${touched} touched, ${sent} sent to the model, ${exceptions} with an exception, ${confirmed} recorded as they were`,
  ];
}

// ---- The JSON twins ----

// The folder of the clone that a folder of a scope's report stands for: `notes` is the scope's own.
const folderOf = (scope, label) => (label === GLOBAL ? GLOBAL : scopeFolder(scope));

// The JSON twin of buildReport's report, from the same figures, and `endedAt`, when the scope's run
// ended (the apply step's time; `date` is its day). A change is `{ kind, path }`, a retirement also
// with `target`; kinds are `add`, `change` and `retire`, in the report's order. A path is relative
// to the clone (`global/<note>`, `projects/<name>/<note>`). A name that the report withholds (it
// looks like a credential) has no path: `{ kind, path: null, folder, withheld: true }`, and a
// withheld target is `target: null` with `targetFolder` and `targetWithheld: true`. Every folder of
// the run is listed, also one it did not change (`changed: false`). No description and no text of a
// note.
export function reportData({ config, kind, scope, date, endedAt, model, stopReason, costUsd, turns, denials, pairs, ev, conversation, repaired = 0 }) {
  const labels = pairs.map((p) => p.label);
  const order = (c) => `${labels.indexOf(c.label)}\u0000${c.file}`;
  const sorted = [...ev.changes].sort((x, y) => byName(order(x), order(y)));
  // The report's decision, so that the twin withholds exactly the names the report does.
  const where = (label, file) => {
    const text = display(label, file);
    return shown(text) === text ? { path: `${folderOf(scope, label)}/${file}` } : { path: null, folder: folderOf(scope, label), withheld: true };
  };
  const changes = CHANGE_KINDS.flatMap((k) => sorted.filter((c) => c.kind === k)).map((c) => {
    const entry = { kind: c.kind, ...where(c.label, c.file) };
    if (c.kind !== 'retire') return entry;
    const t = where(c.target.label, c.target.file);
    return { ...entry, ...(t.withheld ? { target: null, targetFolder: t.folder, targetWithheld: true } : { target: t.path }) };
  });
  const ofKind = (k) => changes.filter((c) => c.kind === k).length;
  const notNotes = labels.reduce((n, l) => n + (ev.ignoredEntries?.[l] > 0 ? ev.ignoredEntries[l] : 0), 0);
  const r = ev.stats.retention;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION, host: config.host, kind, scope, date, endedAt, model, stopReason,
    costUsd: costUsd ?? null, turns: turns ?? null, denials: denials ?? null, repaired,
    conversation: conversation
      ? { truncated: conversation.truncated, bytes: conversation.bytes ?? null, sessionsLeftOut: conversation.sessionsLeftOut }
      : null,
    folders: labels.map((l) => {
      const s = ev.stats[l];
      return {
        folder: folderOf(scope, l), changed: ev.changes.some((c) => c.label === l),
        indexBefore: { lines: s.indexBefore.lines, bytes: s.indexBefore.bytes }, indexAfter: { lines: s.indexAfter.lines, bytes: s.indexAfter.bytes },
        unlistedBefore: s.unlistedBefore, unlistedAfter: s.unlistedAfter,
        notesBytesBefore: s.notesBytesBefore, notesBytesAfter: s.notesBytesAfter, retiredBytes: s.retiredBytes,
      };
    }),
    retention: { termsKept: r.termsKept, termsBefore: r.termsBefore, share: r.share },
    counts: { added: ofKind('add'), changed: ofKind('change'), retired: ofKind('retire'), notApplied: ev.ignored.length + notNotes },
    changes,
  };
}

// Counts of each word of a list, by word.
function countBy(words) {
  const counts = {};
  for (const w of [...words].sort(byName)) counts[w] = (counts[w] ?? 0) + 1;
  return counts;
}

// What the JSON twin of the label report takes from the driver, which writes it into
// label-plan.json beside the report's text: the model's figures (askLabelModel's `asked`), the
// counts of the head, and for each scope of the report (labelResults) the labels it gives (`to`)
// with the label each note had then (`from`), the exceptions left out of the plan because their notes hold their
// labels (`held`: paths), why notes were left (as leftCategory words), the notes Organize must
// repair first, the exceptions that name no note, and the counts of the labels after the run. No
// text of a note, reason of the model or text of an error.
export function labelPlanData({ model, asked, touched, exceptions, confirmed, results, held }) {
  return {
    model, costUsd: asked.spent, requests: asked.requests, sent: asked.sent, stop: asked.stop,
    touched, exceptions, confirmed,
    scopes: results.map((r) => ({
      scope: r.scope,
      labels: r.labels.map((l) => ({ path: l.path, from: l.from, to: l.to })),
      held: held.filter((path) => dirname(path) === r.scope).length,
      leftReasons: countBy(r.left.map((l) => leftCategory(l.why))),
      needsRepair: r.repair.length,
      unmatchedExceptions: r.unmatched.length,
      labelsAfter: r.counts,
    })),
  };
}

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const amount = (v) => (Number.isFinite(v) && v >= 0 ? v : null);
const word = (v) => (typeof v === 'string' ? v : null);
const LABEL_COUNTS = ['work', 'personal', 'general', 'unlabeled'];

// The JSON twin of the label report, which label-apply writes beside it, with `endedAt`, when the
// label pass wrote it (`date` is its day): the plan's figures
// (`data`, labelPlanData's; a figure of the wrong type is null, and without `data` every figure of
// the driver is) and what label-apply did (`written`, `unchanged`, `skipped`, as
// applyLabelEntries gives them). For each scope: the labels set where a note had none and changed
// from another label, the notes whose label was the one given already (with the exceptions that
// held), the notes left for the next run with why (`leftReasons`, leftCategory words; with those
// label-apply did not write), the notes Organize must repair first, the exceptions that name no
// note, and the counts of the labels in the notes after the run (null for a scope the run did not
// read): the report's counts, in which a note that label-apply did not write counts with the label
// it had (or as unlabeled), not with the one planned.
export function labelReportData({ host, date, endedAt, data, written, unchanged, skipped }) {
  const d = isObject(data) ? data : {};
  const planned = new Map((Array.isArray(d.scopes) ? d.scopes : [])
    .filter((s) => isObject(s) && typeof s.scope === 'string').map((s) => [s.scope, s]));
  const applied = [...written, ...unchanged, ...skipped].map((x) => dirname(x.path)).filter((scope) => !planned.has(scope));
  const names = [...planned.keys(), ...[...new Set(applied)].sort(byName)];
  const scopes = names.map((scope) => {
    const p = planned.get(scope) ?? null;
    const mine = (list) => list.filter((x) => dirname(x.path) === scope);
    const plan = p && Array.isArray(p.labels) ? new Map(p.labels.filter(isObject).map((l) => [l.path, l])) : null;
    const writes = mine(written);
    const set = plan === null ? null : writes.filter((w) => plan.get(w.path)?.from === null).length;
    const leftReasons = {};
    const add = (reason, n) => { leftReasons[reason] = (leftReasons[reason] ?? 0) + n; };
    for (const [reason, n] of Object.entries(isObject(p?.leftReasons) ? p.leftReasons : {})) if (count(n) !== null) add(reason, n);
    for (const s of mine(skipped)) add(leftCategory(s.reason), 1);
    const after = isObject(p?.labelsAfter) && LABEL_COUNTS.every((k) => count(p.labelsAfter[k]) !== null)
      ? Object.fromEntries(LABEL_COUNTS.map((k) => [k, p.labelsAfter[k]])) : null;
    for (const s of after === null ? [] : mine(skipped)) {
      const l = plan?.get(s.path);
      const back = LABEL_COUNTS.includes(l?.from) ? l.from : 'unlabeled';
      if (!LABEL_COUNTS.includes(l?.to) || l.to === back || after[l.to] === 0) continue;
      after[l.to] -= 1;
      after[back] += 1;
    }
    return {
      scope, set, changed: set === null ? null : writes.length - set, unchanged: mine(unchanged).length + (count(p?.held) ?? 0),
      left: Object.values(leftReasons).reduce((a, b) => a + b, 0), leftReasons: Object.fromEntries(Object.entries(leftReasons).sort(([a], [b]) => byName(a, b))),
      needsRepair: p ? count(p.needsRepair) : null, unmatchedExceptions: p ? count(p.unmatchedExceptions) : null, labelsAfter: after,
    };
  });
  return {
    schemaVersion: REPORT_SCHEMA_VERSION, host, kind: 'label', date, endedAt, model: word(d.model),
    stopReason: d.stop === null ? 'completed' : word(d.stop),
    costUsd: amount(d.costUsd), turns: null, denials: null, repaired: null, requests: count(d.requests), sent: count(d.sent),
    notes: { touched: count(d.touched), exceptions: count(d.exceptions), recordedAsTheyWere: count(d.confirmed) },
    written: written.length, unchanged: scopes.reduce((n, s) => n + s.unchanged, 0), notWritten: skipped.length,
    scopes,
  };
}

// ---- Reading a report's Markdown back ----

const HOST = '([a-z0-9][a-z0-9-]{0,30})';
const TITLE_RE = new RegExp(`^# (Extract|Organize) (.+) — (\\d{4}-\\d\\d-\\d\\d) on ${HOST}$`);
const MODEL_LINE_RE = /^- Model: (\S+); turns: (\d+|unknown); cost: USD (\d+\.\d\d|unknown); stopped: (\S+); denials: (\d+|unknown)$/;
const REPAIR_LINE_RE = /^- Repair: one repair run; the first check found (\d+) problem\(s\)$/;
const CUT_LINE_RE = /^- Conversation text: cut to (\d+) bytes; (\d+) session\(s\) left out$/;
const INDEX_LINE_RE = /^- Index( \(global\/\))?: (\d+) lines, (\d+) bytes → (\d+) lines, (\d+) bytes$/;
const UNLISTED_LINE_RE = /^- Notes not listed in the index( \(global\/\))?: (\d+) → (\d+)$/;
const NOTES_LINE_RE = /^- Notes( \(global\/\))?: (\d+) bytes → (\d+) bytes; retired: (\d+) bytes$/;
const TERMS_LINE_RE = /^- Distinct terms kept: \d+% \((\d+) of (\d+)\)$/;
const NOT_NOTES_LINE_RE = /^- (?:global\/)?\((?:1 entry that is not a note file|(\d+) entries that are not note files)\): ignored$/;
const LABEL_TITLE_RE = new RegExp(`^# Labels — (\\d{4}-\\d\\d-\\d\\d) on ${HOST}$`);
const LABEL_MODEL_LINE_RE = /^- Model: (\S+); requests: (\d+); cost: USD (\d+\.\d\d|unknown)$/;
const LABEL_NOTES_LINE_RE = /^- Notes: (\d+) touched, (\d+) sent to the model, (\d+) with an exception, (\d+) recorded as they were$/;
const known = (text) => (text === 'unknown' ? null : Number(text));

// The fields of a report's JSON twin, read from its Markdown: of an Extract or Organize report its
// head and its lists, of a label report its head. What the Markdown does not hold is null: the cost
// beyond cents, the size of a complete conversation, the note sizes of a folder the run did not
// change, when the run ended, the folder of a withheld name in a run with two folders, and of a
// label report its stop and what label-apply did; a folder the report does not show is not listed.
// Null when the text is not such a report.
export function parseReport(text) {
  const lines = String(text).split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines[1] !== '') return null;
  const label = LABEL_TITLE_RE.exec(lines[0]);
  if (label) return parseLabelHead(lines, label);
  const title = TITLE_RE.exec(lines[0]);
  return title ? parseScopeReport(lines, title) : null;
}

function parseLabelHead(lines, [, date, host]) {
  const model = LABEL_MODEL_LINE_RE.exec(lines[2] ?? '');
  const notes = LABEL_NOTES_LINE_RE.exec(lines[3] ?? '');
  if (!model || !notes) return null;
  return {
    schemaVersion: REPORT_SCHEMA_VERSION, host, kind: 'label', date, endedAt: null, model: model[1], stopReason: null,
    costUsd: known(model[3]), turns: null, denials: null, repaired: null, requests: Number(model[2]), sent: Number(notes[2]),
    notes: { touched: Number(notes[1]), exceptions: Number(notes[3]), recordedAsTheyWere: Number(notes[4]) },
    written: null, unchanged: null, notWritten: null, scopes: null,
  };
}

function parseScopeReport(lines, [, title, scope, date, host]) {
  const model = MODEL_LINE_RE.exec(lines[2] ?? '');
  if (!model) return null;
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION, host, kind: title.toLowerCase(), scope, date, endedAt: null, model: model[1], stopReason: model[4],
    costUsd: known(model[3]), turns: known(model[2]), denials: known(model[5]), repaired: 0, conversation: null,
    folders: [], retention: null, counts: { added: 0, changed: 0, retired: 0, notApplied: 0 }, changes: [],
  };
  const folder = (global) => {
    const name = folderOf(scope, global ? GLOBAL : 'notes');
    let f = report.folders.find((x) => x.folder === name);
    if (!f) {
      f = {
        folder: name, changed: false, indexBefore: null, indexAfter: null, unlistedBefore: null, unlistedAfter: null,
        notesBytesBefore: null, notesBytesAfter: null, retiredBytes: null,
      };
      report.folders.push(f);
    }
    return f;
  };
  let i = 3;
  for (; i < lines.length && lines[i] !== ''; i++) {
    const line = lines[i];
    let m;
    if ((m = REPAIR_LINE_RE.exec(line))) report.repaired = Number(m[1]);
    else if ((m = CUT_LINE_RE.exec(line))) report.conversation = { truncated: true, bytes: Number(m[1]), sessionsLeftOut: Number(m[2]) };
    else if (line === '- Conversation text: complete') report.conversation = { truncated: false, bytes: null, sessionsLeftOut: 0 };
    else if ((m = INDEX_LINE_RE.exec(line))) {
      Object.assign(folder(m[1]), { indexBefore: { lines: Number(m[2]), bytes: Number(m[3]) }, indexAfter: { lines: Number(m[4]), bytes: Number(m[5]) } });
    } else if ((m = UNLISTED_LINE_RE.exec(line))) Object.assign(folder(m[1]), { unlistedBefore: Number(m[2]), unlistedAfter: Number(m[3]) });
    else if ((m = NOTES_LINE_RE.exec(line))) {
      Object.assign(folder(m[1]), { changed: true, notesBytesBefore: Number(m[2]), notesBytesAfter: Number(m[3]), retiredBytes: Number(m[4]) });
    } else if ((m = TERMS_LINE_RE.exec(line))) {
      const [kept, before] = [Number(m[1]), Number(m[2])];
      report.retention = { termsKept: kept, termsBefore: before, share: before === 0 ? 1 : kept / before };
    } else return null;
  }
  if (report.retention === null) return null;
  const sections = { Added: 'add', Changed: 'change', Retired: 'retire', 'Not applied': null };
  let section;
  for (i += 1; i < lines.length; i++) {
    const line = lines[i];
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      if (!Object.hasOwn(sections, heading[1])) return null;
      section = heading[1];
      continue;
    }
    if (section === undefined || !line.startsWith('- ')) return null;
    const item = line.slice(2);
    if (section === 'Not applied') {
      const n = NOT_NOTES_LINE_RE.exec(line);
      report.counts.notApplied += n?.[1] === undefined ? 1 : Number(n[1]);
      continue;
    }
    const kind = sections[section];
    if (kind === 'add') {
      const dash = item.indexOf(' — ');
      if (dash < 0) return null;
      report.changes.push({ kind, path: item.slice(0, dash) });
    } else if (kind === 'change') {
      report.changes.push({ kind, path: item });
    } else {
      const parts = item.split(' → ');
      if (parts.length !== 2) return null;
      report.changes.push({ kind, path: parts[0], target: parts[1] });
    }
  }
  for (const c of report.changes) report.counts[{ add: 'added', change: 'changed', retire: 'retired' }[c.kind]] += 1;
  // The report's notation, relative to the scope's folder, as the twin's, relative to the clone. A
  // withheld name keeps its folder only when the run had one folder: Extract, or Organize of global/.
  const own = folderOf(scope, 'notes');
  const single = report.kind === 'extract' || scope === GLOBAL;
  const where = (text) => {
    if (text === WITHHELD) return { path: null, folder: single ? own : null, withheld: true };
    return { path: text.startsWith(`${GLOBAL}/`) ? text : `${own}/${text}` };
  };
  report.changes = report.changes.map((c) => {
    const entry = { kind: c.kind, ...where(c.path) };
    if (c.kind !== 'retire') return entry;
    const t = where(c.target);
    return { ...entry, ...(t.withheld ? { target: null, targetFolder: t.folder, targetWithheld: true } : { target: t.path }) };
  });
  return report;
}
