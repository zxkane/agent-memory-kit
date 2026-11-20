// `run.sh consolidate report`: what consolidation did in a window of time, for a person or a
// program. It reads the reports in the clone's `_reports/` (every machine's: the clone holds them
// all), this machine's run log, the clone's scope folders with consolidate.json (the backlog of
// Organize, judged by organizeDue, the rule Organize uses) and the labels of the notes with the
// label step's record. Read-only: no network, no model, no lock, nothing written; it loads no AWS
// code and no module of the label client. A file or a line it cannot read is named in `problems`
// and left out, never fatal.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LABELS } from './domains.mjs';
import { collectScopeNotes, labelRecordOf } from './label-notes.mjs';
import { selectTouched } from './label-run.mjs';
import { REPORT_NAME_RE, REPORT_SCHEMA_VERSION, parseReport, shown, usd } from './reports.mjs';
import { readRunLog } from './run-log.mjs';
import {
  GLOBAL, cloneProblem, listProjects, liveFolder, lstatOrNull, neverOrganized, organizeDue, scopeFolder, scopeInfo,
} from './scopes.mjs';
import { readRegular } from './workdir.mjs';

const DAY_MS = 24 * 3600 * 1000;
const MAX_REPORT_BYTES = 1024 * 1024;
const MAX_DAYS = 365;
const DATE_RE = /^\d{4}-\d\d-\d\d$/;
const KINDS = ['extract', 'organize', 'label'];
export const REPORT_USAGE = 'usage: run.sh consolidate report [--since <YYYY-MM-DD> | --days <n>] [--format json|md]';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// A calendar day written YYYY-MM-DD.
const isDay = (value) => DATE_RE.test(value ?? '') && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

// The command line: `{ since, format }` (`since` a Date), or null for a usage error. The window ends
// at `now`; it starts `--days` days before (7 without either option) or at the start (UTC) of the
// `--since` day, which may not lie after `now`.
export function parseReportArgs(argv, now) {
  let days = null;
  let sinceDay = null;
  let format = null;
  for (let i = 0; i < argv.length; i++) {
    const [arg, value] = [argv[i], argv[i + 1]];
    if (arg === '--days' && days === null && sinceDay === null && /^[1-9]\d{0,2}$/.test(value ?? '') && Number(value) <= MAX_DAYS) {
      days = Number(value);
    } else if (arg === '--since' && days === null && sinceDay === null && isDay(value)) {
      sinceDay = value;
    } else if (arg === '--format' && format === null && ['json', 'md'].includes(value)) {
      format = value;
    } else {
      return null;
    }
    i += 1;
  }
  const since = sinceDay === null ? new Date(now.getTime() - (days ?? 7) * DAY_MS) : new Date(`${sinceDay}T00:00:00.000Z`);
  if (since.getTime() > now.getTime()) return null;
  return { since, format: format ?? 'md' };
}

// consolidate.json as Organize and the label step read it, without moving a file that cannot be
// read aside (the driver's readState does): its scopes' records and the label step's record, or
// empty ones.
function readState(stateDir, problems) {
  const empty = { projects: {}, labels: null };
  let buf;
  try {
    buf = readRegular(join(stateDir, 'consolidate.json'));
  } catch {
    buf = null;
  }
  if (buf === null) {
    if (lstatOrNull(join(stateDir, 'consolidate.json')) !== null) problems.push({ file: 'consolidate.json', problem: 'cannot be read' });
    return empty;
  }
  let raw;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    problems.push({ file: 'consolidate.json', problem: 'not valid JSON' });
    return empty;
  }
  if (!isObject(raw) || (raw.projects !== undefined && !isObject(raw.projects))) {
    problems.push({ file: 'consolidate.json', problem: 'not a state file of the kit' });
    return empty;
  }
  const projects = Object.fromEntries(Object.entries(raw.projects ?? {}).filter(([, entry]) => isObject(entry)));
  return { projects, labels: labelRecordOf(raw) };
}

// The reports of the window: each `.json` twin, and each `.md` report without one, which
// parseReport reads (`source: 'markdown'`), by date, then by name. A report is in the window when
// the day of its name lies between the window's first and last days.
function readReports(repoDir, window, problems) {
  const dir = join(repoDir, '_reports');
  const st = lstatOrNull(dir);
  if (st === null) return [];
  if (!st.isDirectory()) {
    problems.push({ file: '_reports', problem: 'not a folder' });
    return [];
  }
  const [first, last] = [window.since.slice(0, 10), window.until.slice(0, 10)];
  let names;
  try {
    names = readdirSync(dir).sort(byName);
  } catch {
    problems.push({ file: '_reports', problem: 'cannot be read' });
    return [];
  }
  const twins = new Set(names.filter((n) => n.endsWith('.json')));
  const reports = [];
  for (const name of names) {
    const m = REPORT_NAME_RE.exec(name);
    if (!m || m[1] < first || m[1] > last) continue;
    const base = name.slice(0, -m[2].length - 1);
    if (m[2] === 'md' && twins.has(`${base}.json`)) continue;
    // The name of a file in the clone may hold anything; one that looks like a credential is withheld.
    const file = `_reports/${shown(name)}`;
    let buf = null;
    try {
      buf = readRegular(join(dir, name), null, { maxBytes: MAX_REPORT_BYTES });
    } catch {
      buf = null;
    }
    if (buf === null) {
      problems.push({ file, problem: 'cannot be read' });
      continue;
    }
    const text = buf.toString('utf8');
    let data;
    if (m[2] === 'md') {
      data = parseReport(text);
      if (data === null) {
        problems.push({ file, problem: 'not a report the kit wrote' });
        continue;
      }
    } else {
      try {
        data = JSON.parse(text);
      } catch {
        problems.push({ file, problem: 'not valid JSON' });
        continue;
      }
      if (!isObject(data) || data.schemaVersion !== REPORT_SCHEMA_VERSION || !KINDS.includes(data.kind)
        || typeof data.host !== 'string' || typeof data.date !== 'string') {
        problems.push({ file, problem: 'not a report of schemaVersion 1' });
        continue;
      }
    }
    const source = m[2] === 'md' ? 'markdown' : 'json';
    reports.push(Object.assign({ file, source }, data, { file, source }));
  }
  return reports.sort((a, b) => byName(a.date, b.date) || byName(a.file, b.file));
}

// The scope folders of the clone that Organize takes: global/ (when it may be used) and each
// project folder.
function scopeDirs(config, problems) {
  const global = liveFolder(config, GLOBAL);
  let projects = [];
  try {
    projects = listProjects(config);
  } catch {
    problems.push({ file: 'projects', problem: 'cannot be read' });
  }
  return [...(global ? [{ name: GLOBAL, dir: global }] : []), ...projects.map((name) => ({ name, dir: liveFolder(config, name) }))]
    .filter((s) => s.dir !== null);
}

// Organize's backlog: for each scope its notes, whether it is due (organizeDue) and why, whether it
// was ever organized, whether its index is over the limits, and when it was last organized; the
// totals (of the scopes that hold notes), and with an Organize schedule how many weekly runs of
// maxProjects scopes the due scopes take.
function readBacklog(config, scopes, state, now, problems) {
  const list = [];
  for (const s of scopes) {
    let info;
    try {
      info = scopeInfo(s.dir);
    } catch {
      problems.push({ file: scopeFolder(s.name), problem: 'cannot be read' });
      continue;
    }
    const entry = state.projects[s.name];
    const due = organizeDue(info, entry, now.getTime());
    list.push({
      scope: s.name, notes: info.notes, due: due !== null, dueReason: due, neverOrganized: neverOrganized(entry),
      overLimits: info.overLimit, lastOrganize: neverOrganized(entry) ? null : entry.lastOrganize,
    });
  }
  const withNotes = list.filter((x) => x.notes > 0);
  const due = list.filter((x) => x.due).length;
  const c = config.consolidate;
  return {
    scopes: list,
    totals: {
      scopes: list.length, withNotes: withNotes.length, notes: list.reduce((n, x) => n + x.notes, 0), due,
      neverOrganized: withNotes.filter((x) => x.neverOrganized).length, overLimits: withNotes.filter((x) => x.overLimits).length,
    },
    maxProjects: c?.maxProjects ?? null,
    etaWeeks: c?.organize ? Math.ceil(due / c.maxProjects) : null,
  };
}

// The labels of the clone's notes: how many carry each label and which carry none, how many the
// next label run takes (notes the label step's record has no entry for, or that changed since),
// and how many Organize must repair before the step can label them.
function readLabels(scopes, state, problems) {
  const notes = [];
  for (const s of scopes) {
    try {
      notes.push(...collectScopeNotes(s.dir, scopeFolder(s.name)));
    } catch {
      if (!problems.some((p) => p.file === scopeFolder(s.name))) problems.push({ file: scopeFolder(s.name), problem: 'cannot be read' });
    }
  }
  const counts = Object.fromEntries([...LABELS, 'unlabeled'].map((label) => [label, 0]));
  for (const n of notes) counts[LABELS.includes(n.domain) ? n.domain : 'unlabeled'] += 1;
  const editable = notes.filter((n) => n.skip === null).map((n) => ({ ...n, digest: n.sha256 }));
  return {
    recorded: state.labels !== null, counts,
    unlabeled: notes.filter((n) => !LABELS.includes(n.domain)).map((n) => shown(n.path)),
    pending: selectTouched({ notes: editable, record: state.labels, all: false }).touched.length,
    needsRepair: notes.length - editable.length,
  };
}

// The report of the window from `since` to `now` (Dates), as the README's "Run records and
// `consolidate report`" describes it.
export function consolidationReport({ config, now, since }) {
  const problems = [];
  const window = { since: since.toISOString(), until: now.toISOString() };
  const log = readRunLog(config.stateDir);
  problems.push(...log.problems);
  const runs = log.runs.filter((run) => {
    const t = Date.parse(run.endedAt);
    return t >= since.getTime() && t <= now.getTime();
  });
  if (config.consolidateProblem) problems.push({ file: null, problem: `the consolidate block is invalid (${config.consolidateProblem})` });
  let clone = null;
  try {
    const why = cloneProblem(config);
    if (why !== null) clone = why.endsWith('does not exist') ? 'the notes clone does not exist' : 'the notes folder is not a Git clone';
  } catch {
    clone = 'the notes clone cannot be read';
  }
  let reports = [];
  let scopes = [];
  if (clone === null) {
    reports = readReports(config.repoDir, window, problems);
    scopes = scopeDirs(config, problems);
  } else {
    problems.push({ file: null, problem: clone });
  }
  const state = readState(config.stateDir, problems);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION, generatedAt: now.toISOString(), host: config.host, window,
    reports, runs, backlog: readBacklog(config, scopes, state, now, problems), labels: readLabels(scopes, state, problems), problems,
  };
}

// ---- The summary for a terminal ----

// What the summary shows of a value read from a file: text without control characters, a number,
// or `?` for a figure that is missing or not a number.
const plain = (v) => String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
const num = (v) => (Number.isFinite(v) ? v : '?');
const money = (v) => usd(Number.isFinite(v) ? v : null);
const minute = (iso) => plain(`${iso.slice(0, 10)} ${iso.slice(11, 16)}`);

function runLine(run) {
  const kind = `${plain(run.kind)}${run.agents === true ? ' --agents' : ''}${run.dryRun === true ? ' (dry run)' : ''}`;
  const parts = [`exit ${num(run.exitCode)}`];
  if (run.error) parts.push(`error ${plain(run.error)}`);
  if (run.stop) parts.push(`stopped: ${plain(run.stop)}`);
  const scopes = Array.isArray(run.scopes) ? run.scopes.filter(isObject) : [];
  if (scopes.length > 0) parts.push(`${scopes.length} scope(s) (${scopes.map((s) => `${plain(s.scope)} ${plain(s.outcome)}`).join(', ')})`);
  if (isObject(run.label)) parts.push(`label ${plain(run.label.outcome)}, ${num(run.label.written)} written${run.label.failed === true ? ', failed' : ''}`);
  parts.push(money(run.costUsd));
  return `- ${minute(run.endedAt)} ${kind}: ${parts.join(', ')}`;
}

function reportLine(r) {
  const scope = r.kind === 'label' ? '' : ` ${plain(r.scope)}`;
  let what;
  if (r.kind === 'label') {
    what = r.written === null ? `${num(r.requests)} request(s)` : `${num(r.written)} written, ${num(r.unchanged)} unchanged, ${num(r.notWritten)} not written`;
  } else {
    const c = isObject(r.counts) ? r.counts : {};
    what = `${num(c.added)} added, ${num(c.changed)} changed, ${num(c.retired)} retired`;
  }
  const from = r.source === 'markdown' ? ' (from the Markdown)' : '';
  return `- ${plain(r.date)} ${plain(r.host)} ${r.kind}${scope}: ${what}, ${money(r.costUsd)}${from}`;
}

// The report as a short text for a terminal.
export function reportSummary(report) {
  const lines = [`Consolidation on ${report.host}, ${minute(report.window.since)} to ${minute(report.window.until)} UTC`, ''];
  const failed = report.runs.filter((r) => r.exitCode !== 0).length;
  lines.push(report.runs.length === 0 ? 'Runs on this machine: none' : `Runs on this machine: ${report.runs.length}, ${failed} failed`);
  lines.push(...report.runs.map(runLine), '');
  const hosts = [...new Set(report.reports.map((r) => r.host))].sort(byName)
    .map((host) => `${plain(host)} ${report.reports.filter((r) => r.host === host).length}`);
  lines.push(report.reports.length === 0 ? 'Reports: none' : `Reports: ${report.reports.length} (${hosts.join(', ')})`);
  lines.push(...report.reports.map(reportLine), '');
  const b = report.backlog;
  let backlog = `Organize backlog: ${b.totals.due} of ${b.totals.withNotes} scope(s) with notes due`
    + ` (${b.totals.neverOrganized} never organized, ${b.totals.overLimits} over the index limits)`;
  if (b.etaWeeks !== null) backlog += `; about ${b.etaWeeks} week(s) at ${b.maxProjects} a run`;
  lines.push(backlog);
  const c = report.labels.counts;
  lines.push(`Labels: ${c.work} work, ${c.personal} personal, ${c.general} general, ${c.unlabeled} unlabeled;`
    + ` ${report.labels.pending} note(s) for the next label run`);
  lines.push(report.problems.length === 0 ? 'Problems: none' : `Problems: ${report.problems.length}`);
  for (const p of report.problems) lines.push(`- ${p.file === null ? '' : `${plain(p.file)}${p.line ? ` line ${p.line}` : ''}: `}${p.problem}`);
  return `${lines.join('\n')}\n`;
}
