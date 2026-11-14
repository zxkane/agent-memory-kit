// Consolidation: lets a model tidy the notes (organize) or add what recent conversations show
// (extract), one scope at a time, on a private copy. Started through `run.sh consolidate`, which
// holds consolidate.lock. Everything that reads or writes the clone runs as a locked step
// (`run.sh consolidate-step scan|snapshot|apply`, under the sync lock); the model only ever sees
// the work folder, and its result is applied only when the rules in lib/workdir.mjs accept it.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_RE, configPath, loadConfig } from './lib/config.mjs';
import { modelArgs, renderPrompt, runModel } from './lib/model-run.mjs';
import { INDEX, NOTE_NAME_RE, indexStats, parseNote } from './lib/notes.mjs';
import { scanText } from './lib/secret-scan.mjs';
import { runSync, writeStatus } from './lib/sync-engine.mjs';
import { buildDigest, projectSessionDirs, sessionFilesSince } from './lib/transcripts.mjs';
import { apply, evaluate, noteFiles, readRegular, snapshot } from './lib/workdir.mjs';

const RUN_SH = join(dirname(fileURLToPath(import.meta.url)), 'run.sh');
const KINDS = ['extract', 'organize'];
const GLOBAL = 'global';
const INDEX_MAX_LINES = 200;
const INDEX_MAX_BYTES = 25000;
const DAY_MS = 24 * 3600 * 1000;
const EXTRACT_LOOKBACK_MS = 7 * DAY_MS;
// The session window of a project that was extracted before never reaches back further than this.
const EXTRACT_MAX_WINDOW_MS = 28 * DAY_MS;
const REPORT_KEEP_DAYS = 90;
const REVISIT_MS = 28 * DAY_MS;
const KEEP_MARKER = '.keep';
// The read-only reference copy of the scope's notes that a repair run gets, in the work folder.
const ORIGINAL = 'original';
// The least budget, in USD, that must be left for a repair run.
const REPAIR_MIN_USD = 0.1;
// Exit code of `run.sh consolidate-step` when the wait for the sync lock timed out.
const LOCK_TIMEOUT_CODE = 75;
const NOT_CONFIGURED = 'agent-memory: consolidation is not configured.';
const USAGE = 'usage: run.sh consolidate extract|organize [--project <name>]... [--dry-run] [--keep] [--model <id>] [--min-retention <0..1>]';
const CONFLICT_RE = /\.conflict-[^/]*\.md$/;
const REPORT_RE = /^(\d{4}-\d\d-\d\d)-.+\.md$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const STOP_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const RETENTION_RE = /^(?:0(?:\.\d+)?|1(?:\.0+)?|\.\d+)$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isMissing = (err) => err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
const firstLine = (err) => String(err?.message ?? err).split('\n')[0] || 'failed';
const usd = (value) => `USD ${value === null || value === undefined ? 'unknown' : value.toFixed(2)}`;
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// A folder name the driver may use as a project scope: no separator, not hidden, printable.
// A project folder named `global` would be confused with the global scope and is never used.
function isPlainName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200 && !name.includes('/')
    && !name.startsWith('.') && !CONTROL_RE.test(name) && name !== GLOBAL;
}

function parseRetention(value) {
  if (typeof value !== 'string' || !RETENTION_RE.test(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

// SHA-256 over the sorted `name:hash` lines of a folder's note files.
function folderDigest(dir) {
  return sha256([...noteFiles(dir)].map(([name, buf]) => `${name}:${sha256(buf)}`).join('\n'));
}

function scopeInfo(dir) {
  const files = noteFiles(dir);
  const index = files.get(INDEX);
  const stats = indexStats(index ? index.toString('utf8') : '');
  const names = [...files.keys()];
  return {
    notes: names.filter((n) => n !== INDEX).length,
    overLimit: stats.lines > INDEX_MAX_LINES || stats.bytes > INDEX_MAX_BYTES,
    conflict: names.some((n) => CONFLICT_RE.test(n)),
    digest: sha256(names.map((n) => `${n}:${sha256(files.get(n))}`).join('\n')),
  };
}

// ---- Folders of the clone that a run may touch ----

function projectsDir(config) {
  const dir = join(config.repoDir, 'projects');
  return lstatOrNull(dir)?.isDirectory() ? dir : null;
}

// Plain, real folders directly under <repoDir>/projects.
function listProjects(config) {
  const dir = projectsDir(config);
  if (!dir) return [];
  return readdirSync(dir).filter((n) => isPlainName(n) && lstatOrNull(join(dir, n))?.isDirectory()).sort(byName);
}

// The live folder of a scope, or null when it may not be touched. global/ may be missing (an
// apply creates it); a project folder must exist.
function liveFolder(config, scope) {
  if (scope === GLOBAL) {
    const dir = join(config.repoDir, GLOBAL);
    const st = lstatOrNull(dir);
    return !st || st.isDirectory() ? dir : null;
  }
  const base = isPlainName(scope) ? projectsDir(config) : null;
  if (!base) return null;
  const dir = join(base, scope);
  return lstatOrNull(dir)?.isDirectory() ? dir : null;
}

// Extract: the project folder. Organize: the scope folder, plus global/ for a project.
function pairsFor(config, kind, scope, work) {
  if (kind === 'extract' && scope === GLOBAL) return null;
  const live = liveFolder(config, scope);
  if (!live) return null;
  const pairs = [{ label: 'notes', liveDir: live, workDir: join(work, 'notes') }];
  if (kind === 'organize' && scope !== GLOBAL) {
    const global = liveFolder(config, GLOBAL);
    if (global) pairs.push({ label: GLOBAL, liveDir: global, workDir: join(work, GLOBAL) });
  }
  return pairs;
}

const workRoot = (config) => join(config.stateDir, 'consolidate');

// A work folder given to a step: its real path, a scope folder of a run folder under
// <stateDir>/consolidate.
function checkWork(config, work) {
  if (typeof work !== 'string' || !isAbsolute(work)) throw new Error('the work folder must be an absolute path');
  const real = realpathSync(work);
  if (real !== work) throw new Error('the work folder must be given as its real path');
  if (dirname(dirname(real)) !== realpathSync(workRoot(config))) throw new Error('the work folder is not a consolidation work folder');
  if (!lstatSync(real).isDirectory()) throw new Error('the work folder is not a folder');
  return real;
}

const syncInfo = (s) => ({ ok: s.ok, error: s.error ?? null, committed: s.committed ?? 0, pushed: !!s.pushed });

// A name shown in output or in a report; one that looks like a credential is not shown.
function shown(text) {
  return scanText(String(text)).length > 0 ? '(file name withheld)' : String(text);
}

// What reached the model of an Extract run: whether the digest was cut, how large it is, and how
// many qualifying sessions it left out entirely. Passed to the apply step as one argument.
function conversationOf(digest) {
  return { truncated: digest.truncated, bytes: Buffer.byteLength(digest.text, 'utf8'), sessionsLeftOut: digest.sessionsLeftOut };
}

function conversationArg(conversation) {
  if (!conversation) return 'none';
  return conversation.truncated ? `cut,${conversation.bytes},${conversation.sessionsLeftOut}` : 'complete';
}

function parseConversationArg(value) {
  if (value === 'none') return null;
  if (value === 'complete') return { truncated: false, bytes: null, sessionsLeftOut: 0 };
  const m = /^cut,(\d{1,12}),(\d{1,9})$/.exec(value ?? '');
  if (!m) throw new Error('invalid --conversation');
  return { truncated: true, bytes: Number(m[1]), sessionsLeftOut: Number(m[2]) };
}

// ---- Locked steps ----

function parseStepArgs(rest, valued, flags = []) {
  const opts = Object.create(null);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (flags.includes(a) && !(a in opts)) {
      opts[a] = true;
    } else if (valued.includes(a) && !(a in opts) && i + 1 < rest.length) {
      opts[a] = rest[++i];
    } else {
      throw new Error(`unexpected step argument ${JSON.stringify(String(a).slice(0, 40))}`);
    }
  }
  for (const a of valued) if (!(a in opts)) throw new Error(`missing step argument ${a}`);
  return opts;
}

// Why the configured clone cannot be used, or null.
function cloneProblem(config) {
  let st = null;
  try {
    st = statSync(config.repoDir);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  if (!st?.isDirectory()) return `the notes clone ${config.repoDir} does not exist`;
  if (lstatOrNull(join(config.repoDir, '.git')) === null) return `${config.repoDir} is not a Git clone of the notes`;
  return null;
}

function stepScan(config) {
  const problem = cloneProblem(config);
  if (problem) throw new Error(problem);
  const dir = projectsDir(config);
  const projects = listProjects(config).map((name) => ({ name, ...scopeInfo(join(dir, name)) }));
  const g = liveFolder(config, GLOBAL);
  const global = g ? { usable: true, ...scopeInfo(g) } : { usable: false };
  const names = new Set(projects.map((p) => p.name));
  const sessions = [...projectSessionDirs(config)].filter(([name]) => names.has(name));
  // A project folder named like the global scope would be confused with it; it is never used.
  const ignored = dir && lstatOrNull(join(dir, GLOBAL))?.isDirectory() ? [GLOBAL] : [];
  out({ outcome: 'scan', projects, global, sessions, ignored });
}

function stepSnapshot(config, rest) {
  const a = parseStepArgs(rest, ['--work', '--kind', '--scope']);
  const kind = a['--kind'];
  const scope = a['--scope'];
  if (!KINDS.includes(kind)) throw new Error('unknown kind');
  if (!(scope === GLOBAL || isPlainName(scope)) || (kind === 'extract' && scope === GLOBAL)) throw new Error('invalid scope');
  const work = checkWork(config, a['--work']);
  if (basename(work) !== scope) throw new Error('the work folder does not belong to the scope');
  if (readdirSync(work).length > 0) throw new Error('the work folder is not empty');
  const sync = syncInfo(writeStatus(config, runSync(config)));
  if (!sync.ok) {
    out({ outcome: 'sync-failed', sync });
    return;
  }
  const pairs = pairsFor(config, kind, scope, work);
  if (!pairs) {
    out({ outcome: 'skipped', reason: 'the scope folder is not available', sync });
    return;
  }
  const snap = snapshot(pairs);
  const plan = { kind, scope, pairs, snap };
  writeFileSync(join(work, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  out({ outcome: 'snapshot', sync });
}

function validSnap(snap, pairs) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return false;
  const labels = pairs.map((p) => p.label);
  if (Object.keys(snap).length !== labels.length || !labels.every((l) => Object.hasOwn(snap, l))) return false;
  return labels.every((l) => {
    const files = snap[l];
    return files && typeof files === 'object' && !Array.isArray(files)
      && Object.entries(files).every(([name, hash]) => NOTE_NAME_RE.test(name) && HASH_RE.test(hash));
  });
}

// `<label>/<file>` (as evaluate names it) shown relative to the scope: global/ keeps its prefix.
function display(label, file) {
  return label === GLOBAL ? `global/${file}` : file;
}

// Error lines of evaluate that name an entry which is not a note file quote its name, which the
// model chose and which may hold any text. They are replaced by a count per folder.
function safeErrors(errors, labels) {
  const kept = [];
  const counts = new Map();
  for (const line of errors) {
    const label = labels.find((l) => line.startsWith(`${l}/"`));
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    else kept.push(line);
  }
  for (const [label, n] of counts) {
    const what = n === 1 ? '1 entry that is not a note file' : `${n} entries that are not note files`;
    kept.push(`${label}/(${what}): not a regular note file`);
  }
  return kept;
}

function splitLoc(entry) {
  const slash = entry.indexOf('/');
  return slash < 0 ? { label: 'notes', file: entry } : { label: entry.slice(0, slash), file: entry.slice(slash + 1) };
}

function cleanDescription(text) {
  const d = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (d === '') return '(no description)';
  return d.length > 200 ? `${d.slice(0, 200)}…` : d;
}

function buildReport({ config, kind, scope, date, model, stopReason, costUsd, turns, denials, pairs, snap, ev, descriptions, conversation, repaired = 0 }) {
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
  section('Not applied', ev.ignored.map((entry) => {
    const { label, file } = splitLoc(entry);
    const known = snap[label] && Object.hasOwn(snap[label], file);
    const why = known ? 'retiring a note is not part of an extract run' : 'a new file cannot be a retirement';
    return `- ${display(label, file)}: ${why}`;
  }));
  return `${lines.join('\n')}\n`;
}

function writeReport(config, name, text) {
  const dir = join(config.repoDir, '_reports');
  const st = lstatOrNull(dir);
  if (st && !st.isDirectory()) throw new Error('_reports is not a folder');
  if (!st) mkdirSync(dir);
  const dest = join(dir, name);
  const existing = lstatOrNull(dest);
  if (existing && !existing.isFile()) throw new Error(`_reports/${name} is not a regular file`);
  const tmp = `${dest}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// Deletes reports whose date is more than REPORT_KEEP_DAYS days before `now`.
function pruneReports(config, now) {
  const dir = join(config.repoDir, '_reports');
  if (!lstatOrNull(dir)?.isDirectory()) return;
  const cutoff = new Date(now.getTime() - REPORT_KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
  for (const name of readdirSync(dir)) {
    const m = REPORT_RE.exec(name);
    if (!m || m[1] >= cutoff) continue;
    if (lstatOrNull(join(dir, name))?.isFile()) unlinkSync(join(dir, name));
  }
}

function stepApply(config, rest) {
  const a = parseStepArgs(rest,
    ['--work', '--plan-sha256', '--stop-reason', '--cost', '--turns', '--denials', '--model', '--min-retention', '--conversation', '--repaired'],
    ['--dry-run', '--keep-original']);
  const dryRun = a['--dry-run'] === true;
  const minRetention = a['--min-retention'] === 'default' ? undefined : parseRetention(a['--min-retention']);
  if (minRetention === null) throw new Error('invalid --min-retention');
  const stopReason = STOP_RE.test(a['--stop-reason']) ? a['--stop-reason'] : 'unknown';
  const costUsd = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(a['--cost']) ? Number(a['--cost']) : null;
  const turns = /^\d{1,9}$/.test(a['--turns']) ? Number(a['--turns']) : null;
  const denials = /^\d{1,9}$/.test(a['--denials']) ? Number(a['--denials']) : null;
  const model = a['--model'];
  const conversation = parseConversationArg(a['--conversation']);
  const repaired = /^\d{1,6}$/.test(a['--repaired']) ? Number(a['--repaired']) : 0;
  const work = checkWork(config, a['--work']);
  const empty = { errors: [], changes: [], ignored: [], stats: {}, liveChanged: [] };

  const planBuf = readRegular(join(work, 'plan.json'));
  if (!planBuf || sha256(planBuf) !== a['--plan-sha256']) {
    out({ ...empty, outcome: 'rejected', errors: ['plan.json was changed after the snapshot'] });
    return;
  }
  const plan = JSON.parse(planBuf.toString('utf8'));
  const { kind, scope } = plan;
  if (!KINDS.includes(kind) || scope !== basename(work)) throw new Error('plan.json does not match its work folder');
  for (const p of plan.pairs ?? []) {
    if (!lstatOrNull(join(work, p.label))?.isDirectory()) {
      out({ ...empty, outcome: 'rejected', errors: [`${p.label}: work folder is not a real folder`] });
      return;
    }
  }
  // Commits what sessions wrote meanwhile under the usual subject, so that the consolidate commit
  // holds only this run's changes. When it fails, nothing is applied: the commit after applying
  // would otherwise take in every pending change of the clone.
  const preSync = dryRun ? null : syncInfo(writeStatus(config, runSync(config)));
  if (preSync && !preSync.ok) {
    out({ ...empty, outcome: 'sync-failed', sync: preSync, preSync });
    return;
  }
  const pairs = pairsFor(config, kind, scope, work);
  if (!pairs || JSON.stringify(pairs) !== JSON.stringify(plan.pairs)) {
    out({ ...empty, outcome: 'changed-meanwhile', reason: 'the scope folder is no longer the folder that was copied', preSync });
    return;
  }
  if (!validSnap(plan.snap, pairs)) throw new Error('plan.json holds an invalid snapshot');
  const snap = plan.snap;

  const ev = evaluate({ pairs, snap, allowRetire: kind === 'organize', minRetention });
  const result = {
    errors: safeErrors(ev.errors, pairs.map((p) => p.label)),
    changes: ev.changes.map((c) => ({ label: c.label, file: shown(c.file), kind: c.kind, target: c.target })),
    ignored: ev.ignored,
    stats: ev.stats,
    liveChanged: ev.liveChanged.map(shown),
    preSync,
  };
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const descriptions = new Map();
  for (const c of ev.changes.filter((x) => x.kind === 'add')) {
    const pair = pairs.find((p) => p.label === c.label);
    const buf = readRegular(join(pair.workDir, c.file));
    if (buf && sha256(buf) === c.hash) descriptions.set(`${c.label}/${c.file}`, cleanDescription(parseNote(buf.toString('utf8')).description));
  }
  const report = () => buildReport({
    config, kind, scope, date, model, stopReason, costUsd, turns, denials, pairs, snap, ev, descriptions, conversation, repaired,
  });

  let outcome;
  if (ev.liveChanged.length > 0) outcome = 'changed-meanwhile';
  else if (ev.errors.length > 0) outcome = 'rejected';
  else if (ev.changes.length === 0) outcome = 'no-change';
  else if (dryRun) outcome = 'dry-run';
  if (outcome) {
    const withReport = dryRun && (outcome === 'dry-run' || outcome === 'rejected');
    const digest = outcome === 'no-change' || outcome === 'rejected' ? folderDigest(pairs[0].liveDir) : null;
    // For a repair run: a reference copy of the scope's notes as the snapshot took them, from the
    // live folder, which this evaluation has just found unchanged. Never evaluated or applied.
    if (outcome === 'rejected' && a['--keep-original'] === true) {
      snapshot([{ label: 'original', liveDir: pairs[0].liveDir, workDir: join(work, ORIGINAL) }]);
    }
    out({ ...result, outcome, report: withReport ? report() : null, digest });
    return;
  }

  try {
    apply({ pairs, changes: ev.changes, snap });
  } catch (err) {
    // Before the first write nothing was applied: something moved since evaluate. After it, part
    // of the result is live and uncommitted (the next sync commits it); say so, never "nothing".
    out({ ...result, outcome: err.partial ? 'apply-interrupted' : 'changed-meanwhile', reason: firstLine(err) });
    return;
  }
  const digest = folderDigest(pairs[0].liveDir);
  let reportError = null;
  try {
    writeReport(config, `${date}-${config.host}-${kind}-${scope}.md`, report());
    if (kind === 'organize') pruneReports(config, now);
  } catch (err) {
    reportError = firstLine(err);
  }
  const where = scope === GLOBAL ? GLOBAL : `projects/${scope}`;
  const sync = syncInfo(writeStatus(config, runSync(config, { message: `consolidate(${config.host}): ${kind} ${where}` })));
  out({ ...result, outcome: 'applied', digest, reportError, sync });
}

function stepMain(args) {
  const [name, ...rest] = args;
  // Once Node runs the apply step, it finishes and reports, even after Ctrl-C (which reaches the
  // whole process group), SIGTERM or SIGHUP: killed part-way, it could have written or committed
  // changes that the driver would then not know of. The handlers come first, before anything
  // else runs (the imported modules only define functions and constants, and nothing before this
  // line reads or writes the clone), so an apply step that dies from one of these signals has
  // done nothing. It is bounded by the Git network time limits; the lock wait in run.sh comes
  // before Node starts. A Git command killed by the same signal is a failed sync, reported as
  // such. scan and snapshot change nothing and may die.
  if (name === 'apply') for (const signal of INTERRUPT_SIGNALS) process.on(signal, () => {});
  const config = loadConfig();
  if (!config || !config.consolidate) {
    out({ outcome: 'error', error: 'consolidation is not configured' });
    return 1;
  }
  try {
    if (name === 'scan' && rest.length === 0) stepScan(config);
    else if (name === 'snapshot') stepSnapshot(config, rest);
    else if (name === 'apply') stepApply(config, rest);
    else throw new Error('usage: run.sh consolidate-step scan | snapshot ... | apply ...');
    return 0;
  } catch (err) {
    process.stderr.write(`agent-memory consolidate-step ${String(name).slice(0, 20)}: ${firstLine(err)}\n`);
    out({ outcome: 'error', error: firstLine(err) });
    return 1;
  }
}

// ---- Driver ----

function parseDriverArgs(argv) {
  const [kind, ...rest] = argv;
  if (!KINDS.includes(kind)) return null;
  const opts = { kind, projects: [], dryRun: false, keep: false, model: undefined, minRetention: undefined };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--keep') {
      opts.keep = true;
    } else if (arg === '--project') {
      const v = rest[++i];
      if (!(v === GLOBAL || isPlainName(v))) return null;
      if (!opts.projects.includes(v)) opts.projects.push(v);
    } else if (arg === '--model') {
      const v = rest[++i];
      if (opts.model !== undefined || typeof v !== 'string' || !MODEL_RE.test(v)) return null;
      opts.model = v;
    } else if (arg === '--min-retention') {
      const v = parseRetention(rest[++i]);
      if (opts.minRetention !== undefined || v === null) return null;
      opts.minRetention = v;
    } else {
      return null;
    }
  }
  if (kind === 'extract' && opts.projects.includes(GLOBAL)) return null;
  return opts;
}

// Runs a locked step. `result` is its JSON line (which may be `{ outcome: 'error', error }`), or
// null when it printed none; `status` and `signal` say how the step ended, so that a lock-wait
// timeout (LOCK_TIMEOUT_CODE from run.sh) and a death by signal can be told from a crash.
function runStep(args) {
  const r = spawnSync(RUN_SH, ['consolidate-step', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024,
  });
  const ended = { status: r.status, signal: r.signal };
  if (r.error || typeof r.stdout !== 'string') return { result: null, ...ended };
  try {
    const value = JSON.parse(r.stdout.trim().split('\n').at(-1));
    const ok = value && typeof value === 'object' && !Array.isArray(value) && typeof value.outcome === 'string';
    return { result: ok ? value : null, ...ended };
  } catch {
    return { result: null, ...ended };
  }
}

const lockTimedOut = (step) => step.result === null && step.status === LOCK_TIMEOUT_CODE;

const stateFile = (config) => join(config.stateDir, 'consolidate.json');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const stampOf = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// The state file. One that cannot be read or parsed is moved aside, never overwritten; the run
// then starts from an empty state. Unknown top-level keys are kept.
function readState(config, now) {
  const file = stateFile(config);
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (isMissing(err)) return { projects: Object.create(null) };
  }
  if (!isObject(raw) || (raw.projects !== undefined && !isObject(raw.projects))) {
    const aside = `${file}.unreadable-${stampOf(now)}`;
    renameSync(file, aside);
    process.stdout.write(`agent-memory consolidate: the state file could not be read; moved to ${aside}, starting from an empty state.\n`);
    return { projects: Object.create(null) };
  }
  const projects = Object.create(null);
  for (const [scope, entry] of Object.entries(raw.projects ?? {})) {
    if (isObject(entry)) projects[scope] = { ...entry };
  }
  return { ...raw, projects };
}

function writeState(config, state) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const file = stateFile(config);
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const timeOf = (iso) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

// Where a project's session window starts: at its last extract, but never more than
// EXTRACT_MAX_WINDOW_MS back (a run that stopped early keeps lastExtract, and the window must not
// grow without end); EXTRACT_LOOKBACK_MS back when it was never extracted.
function windowStart(entry, now) {
  const last = timeOf(entry?.lastExtract);
  return last === null ? now - EXTRACT_LOOKBACK_MS : Math.max(last, now - EXTRACT_MAX_WINDOW_MS);
}

// Extract: projects with a session file changed since their window start. The one whose model
// run was tried longest ago goes first (never tried first, which includes state written before
// `lastExtractTried` existed), so every project gets its turn across runs even when one is
// rejected every time; then the oldest session window, then the newest session.
function extractScopes(scan, state, opts, now) {
  const dirs = new Map(scan.sessions);
  const names = opts.projects.length > 0 ? opts.projects : [...dirs.keys()];
  const list = [];
  for (const scope of names) {
    const tried = timeOf(state.projects[scope]?.lastExtractTried) ?? -Infinity;
    const last = timeOf(state.projects[scope]?.lastExtract);
    const since = windowStart(state.projects[scope], now);
    const files = sessionFilesSince(dirs.get(scope) ?? [], since);
    if (opts.projects.length === 0 && files.length === 0) continue;
    let newest = 0;
    for (const file of files) {
      try {
        newest = Math.max(newest, statSync(file).mtimeMs);
      } catch {
        // Vanished: does not count.
      }
    }
    list.push({ scope, files, since, newest, tried, last: last ?? -Infinity });
  }
  const older = (a, b) => (a === b ? 0 : a - b);
  if (opts.projects.length === 0) {
    list.sort((x, y) => older(x.tried, y.tried) || older(x.last, y.last) || y.newest - x.newest || byName(x.scope, y.scope));
  }
  return list;
}

// Organize: a scope with notes is due when its content changed since it was last organized (or
// it never was). One that did not change but is still over the index limits or still holds a
// conflict copy is due again only after REVISIT_MS: the model could not fix it last time, and
// taking it every week would crowd out the scopes that changed.
// Order, in two groups:
// - A, every due scope except those of group B: by class (over the limits, then a conflict copy,
//   then the others), then by lastOrganizeTried (falling back to lastOrganize), oldest first,
//   never tried first;
// - B, scopes whose last model run left them unorganized (lastOrganizeTried is set and lastOrganize
//   is absent or older) within the last REVISIT_MS: after all of A, by lastOrganizeTried only,
//   whatever their class, so that scopes failing every run rotate among themselves and cannot keep
//   the others waiting. A failed try older than REVISIT_MS puts the scope back into group A, at the
//   front of its class, so that it waits behind the others for at most REVISIT_MS.
function organizeScopes(scan, state, opts, now) {
  const infos = [...(scan.global.usable ? [{ name: GLOBAL, ...scan.global }] : []), ...scan.projects];
  if (opts.projects.length > 0) return opts.projects.map((name) => ({ scope: name }));
  const entry = (i) => state.projects[i.name];
  const last = (i) => timeOf(entry(i)?.lastOrganize) ?? -Infinity;
  const isDue = (i) => {
    if (i.notes === 0) return false;
    if (i.digest !== entry(i)?.organizedDigest) return true;
    return (i.overLimit || i.conflict) && now - last(i) > REVISIT_MS;
  };
  const rank = (i) => (i.overLimit ? 0 : i.conflict ? 1 : 2);
  const failedTry = (i) => {
    const t = timeOf(entry(i)?.lastOrganizeTried);
    const l = timeOf(entry(i)?.lastOrganize);
    return t !== null && (l === null || t > l) ? t : null;
  };
  const leftUnorganized = (i) => {
    const t = failedTry(i);
    return t !== null && now - t <= REVISIT_MS;
  };
  // A scope whose failed try is older than REVISIT_MS counts as the oldest of its class.
  const tried = (i) => {
    const t = failedTry(i);
    if (t !== null && now - t > REVISIT_MS) return -Infinity;
    return timeOf(entry(i)?.lastOrganizeTried) ?? last(i);
  };
  const older = (a, b) => (a === b ? 0 : a - b);
  const due = infos.filter(isDue);
  due.sort((x, y) => {
    const gx = leftUnorganized(x);
    const gy = leftUnorganized(y);
    if (gx !== gy) return gx ? 1 : -1;
    return (gx ? 0 : rank(x) - rank(y)) || older(tried(x), tried(y)) || byName(x.name, y.name);
  });
  return due.map((i) => ({ scope: i.name }));
}

// Removes a folder tree, also one whose folders lost their permissions. Never throws.
function removeTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // Try again after making every folder of the tree accessible.
  }
  const open = (d) => {
    try {
      if (!lstatSync(d).isDirectory()) return;
      chmodSync(d, 0o700);
      for (const name of readdirSync(d)) open(join(d, name));
    } catch {
      // Best effort.
    }
  };
  open(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`agent-memory consolidate: could not remove ${dir}: ${firstLine(err)}\n`);
  }
}

// Run folders left by a run that was killed: removed when older than a day, unless --keep marked
// them. They may hold conversation text.
function removeStaleRuns(config, now) {
  const root = workRoot(config);
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const dir = join(root, name);
    const st = lstatOrNull(dir);
    if (!st?.isDirectory() || now - st.mtimeMs <= DAY_MS) continue;
    if (lstatOrNull(join(dir, KEEP_MARKER)) !== null) continue;
    removeTree(dir);
  }
}

function makeRunDir(config, started, keep) {
  const root = workRoot(config);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const dir = join(root, `${stampOf(started)}-${process.pid}`);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  if (keep) writeFileSync(join(dir, KEEP_MARKER), 'kept by --keep; may contain conversation text\n', { mode: 0o600 });
  return realpathSync(dir);
}

// The model's time limit: the configured minutes, or less when AGENT_MEMORY_MODEL_TIMEOUT_MS
// asks for less (used by tests; it can never raise the limit).
function modelTimeoutMs(c) {
  const configured = c.timeoutMinutes * 60 * 1000;
  const raw = process.env.AGENT_MEMORY_MODEL_TIMEOUT_MS;
  const lower = typeof raw === 'string' && /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : null;
  return lower !== null && lower < configured ? lower : configured;
}

// SIGINT, SIGTERM or SIGHUP: stop the model, apply nothing more, clean up, exit 128 + n.
const SIGNAL_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
const INTERRUPT_SIGNALS = Object.keys(SIGNAL_CODES);
const abort = new AbortController();
let interrupted = null;

function onSignal(signal) {
  if (interrupted) return;
  interrupted = signal;
  abort.abort();
}

// Node runs a signal handler only on a turn of the event loop. A signal that arrived while a
// locked step ran (spawnSync blocks the loop) has not set `interrupted` yet when the step
// returns: every check of the flag after a step waits for one turn first.
async function signalsHandled() {
  await new Promise((resolve) => setImmediate(resolve));
  return interrupted;
}

// One scope: snapshot (locked), model run on the copy, apply (locked).
async function runScope({ config, opts, model, runDir, scope, digest }) {
  const c = config.consolidate;
  const work = join(runDir, scope);
  mkdirSync(work, { mode: 0o700 });
  chmodSync(work, 0o700);
  try {
    const snapStep = runStep(['snapshot', '--work', work, '--kind', opts.kind, '--scope', scope]);
    const snap = snapStep.result;
    if (await signalsHandled()) return { outcome: 'aborted', work };
    if (!snap) return { outcome: 'step-failed', step: 'snapshot', lockTimeout: lockTimedOut(snapStep), work };
    if (snap.outcome !== 'snapshot') return { ...snap, step: 'snapshot', work };
    const planBuf = readFileSync(join(work, 'plan.json'));
    const hasGlobal = JSON.parse(planBuf.toString('utf8')).pairs.some((p) => p.label === GLOBAL);
    let cwd = work;
    let prompt;
    const addDirs = [];
    if (opts.kind === 'extract') {
      const input = join(work, 'input');
      mkdirSync(input, { mode: 0o700 });
      chmodSync(input, 0o700);
      const file = join(input, 'digest.md');
      writeFileSync(file, digest.text, { mode: 0o600, flag: 'wx' });
      chmodSync(file, 0o600);
      cwd = join(work, 'notes');
      prompt = renderPrompt('extract', { digest: file });
      addDirs.push(input);
    } else {
      // The scope's index as the snapshot copied it: the prompt shows its size when it is over a limit.
      const indexBuf = readRegular(join(work, 'notes', INDEX));
      const index = indexStats(indexBuf ? indexBuf.toString('utf8') : '');
      const overLimit = index.lines > INDEX_MAX_LINES || index.bytes > INDEX_MAX_BYTES;
      prompt = renderPrompt('organize', { hasGlobal, overLimit, indexLines: index.lines, indexBytes: index.bytes });
    }
    // One model run on the work folder, with its figures made safe.
    const runOnce = async (runPrompt, budgetUsd, dirs) => {
      const m = await runModel({
        command: c.command,
        args: modelArgs({ prompt: runPrompt, model, maxTurns: c.maxTurns, maxBudgetUsd: budgetUsd, addDirs: dirs }),
        cwd, env: c.env, timeoutMs: modelTimeoutMs(c), signal: abort.signal,
      });
      return {
        ran: m.ran,
        stopReason: STOP_RE.test(m.stopReason) ? m.stopReason : 'unknown',
        costUsd: typeof m.costUsd === 'number' && m.costUsd >= 0 ? m.costUsd : null,
        turns: Number.isInteger(m.turns) ? m.turns : null,
        denials: Number.isInteger(m.denials) && m.denials >= 0 ? m.denials : 0,
        stderrTail: m.stderrTail ?? '',
      };
    };
    const infoOf = (run) => ({ ran: run.ran, stopReason: run.stopReason, costUsd: run.costUsd, denials: run.denials });
    // The apply step for the model figures of `run`: its result, or how it ended without one.
    const applyOnce = async (run, { keepOriginal = false, repaired = 0 } = {}) => {
      const args = [
        'apply', '--work', work, '--plan-sha256', sha256(planBuf), '--stop-reason', run.stopReason,
        '--cost', run.costUsd === null ? 'unknown' : String(run.costUsd), '--turns', run.turns === null ? 'unknown' : String(run.turns),
        '--denials', String(run.denials),
        '--model', model, '--min-retention', opts.minRetention === undefined ? 'default' : String(opts.minRetention),
        '--conversation', conversationArg(digest ? conversationOf(digest) : null), '--repaired', String(repaired),
      ];
      if (keepOriginal) args.push('--keep-original');
      if (opts.dryRun) args.push('--dry-run');
      const applyStep = runStep(args);
      const res = applyStep.result;
      const modelInfo = infoOf(run);
      // An apply step that finished stands, signal or not: its line says what happened to the notes
      // and the run stops afterwards. One that ended without its line ended in one of three ways:
      // - the wait for the sync lock timed out (run.sh exit LOCK_TIMEOUT_CODE): nothing was done;
      // - SIGINT, SIGTERM or SIGHUP killed it: that is only possible before its handlers existed,
      //   so before it did anything. The run stops as interrupted by that signal, even when only
      //   the step received it;
      // - anything else (SIGKILL, a crash): it may have applied and committed changes, so it is
      //   never reported as "nothing applied".
      await signalsHandled();
      if (!res) {
        if (lockTimedOut(applyStep)) return { outcome: 'step-failed', step: 'apply', lockTimeout: true, model: modelInfo, work };
        if (INTERRUPT_SIGNALS.includes(applyStep.signal)) {
          onSignal(applyStep.signal);
          return { outcome: 'aborted', model: modelInfo, work };
        }
        return { outcome: 'apply-interrupted', step: 'apply', model: modelInfo, work };
      }
      return { ...res, step: 'apply', model: modelInfo, work };
    };

    const first = await runOnce(prompt, c.maxBudgetUsd, addDirs);
    if (await signalsHandled()) return { outcome: 'aborted', model: infoOf(first), work };
    // A result the rules reject gets one repair run when the model completed and enough of the
    // scope's budget is left (an unknown cost counts as the whole budget).
    const left = c.maxBudgetUsd - (first.costUsd ?? c.maxBudgetUsd);
    const mayRepair = first.stopReason === 'completed' && left >= REPAIR_MIN_USD;
    const res = await applyOnce(first, { keepOriginal: mayRepair });
    const original = join(work, ORIGINAL);
    if (res.outcome !== 'rejected' || !mayRepair || !lstatOrNull(original)?.isDirectory()) {
      // Nothing to apply from a model that did not complete is a failed run, not "nothing to do":
      // `no-change` always means the model completed and found nothing.
      if (res.outcome === 'no-change' && first.stopReason !== 'completed') {
        // Beside the scope's work folder, in the run folder: no folder the model can write to.
        const stderrLog = join(runDir, `model-stderr-${scope}.log`);
        writeFileSync(stderrLog, first.stderrTail, { mode: 0o600 });
        chmodSync(stderrLog, 0o600);
        return { ...res, outcome: 'model-failed', repairs: 0 };
      }
      return { ...res, repairs: 0 };
    }

    // The repair run: the problems the check found, the notes as they were in original/, and the
    // same task; what is left of the scope's budget; the configured time limit again.
    const problems = res.errors ?? [];
    const repairPrompt = renderPrompt('repair', {
      problems: problems.map((e) => `- ${e}`).join('\n'), original, task: prompt, hasGlobal,
    });
    const second = await runOnce(repairPrompt, Math.floor(left * 100) / 100, opts.kind === 'extract' ? [...addDirs, original] : addDirs);
    const both = sumRuns(first, second);
    const repair = { repairs: 1, firstProblems: problems.length };
    if (await signalsHandled()) return { outcome: 'aborted', model: infoOf(both), work, ...repair };
    // A repair run that did not complete leaves the first check's result, with its stop reason.
    if (second.stopReason !== 'completed') return { ...res, model: infoOf(both), ...repair };
    return { ...(await applyOnce(both, { repaired: problems.length })), ...repair };
  } finally {
    if (!opts.keep) removeTree(work);
  }
}

// The figures of a first run and its repair run together: costs, turns and denials summed (unknown
// when either is unknown), and how the repair run ended.
function sumRuns(first, second) {
  const add = (x, y) => (x === null || y === null ? null : Math.round((x + y) * 1e6) / 1e6);
  return {
    ran: second.ran,
    stopReason: second.stopReason,
    costUsd: add(first.costUsd, second.costUsd),
    turns: add(first.turns, second.turns),
    denials: first.denials + second.denials,
    stderrTail: second.stderrTail,
  };
}

// What a scope's run cost against the run's ceiling. An unknown cost counts as the scope's whole
// budget when the model may have run, and as nothing when it could not start.
function spentBy(res, c) {
  if (!res.model) return 0;
  if (res.model.costUsd !== null) return res.model.costUsd;
  return ['spawn-failed', 'invalid-timeout'].includes(res.model.stopReason) ? 0 : c.maxBudgetUsd;
}

// Stop reasons after which the model command never ran: every later scope would fail the same way.
const NOT_STARTED = ['spawn-failed', 'invalid-timeout'];

// Whether the model process was started for the scope (it may have spent its budget, whatever
// came of it). Not after a command that could not start, nor after a run stopped by a signal.
function modelStarted(res) {
  return !!res.model && ![...NOT_STARTED, 'aborted'].includes(res.model.stopReason);
}

// Moves the scope's marks forward, or not. A dry run moves nothing.
// - Content marks: `lastExtract` (the start of the next session window), and `lastOrganize` with
//   `organizedDigest`. They move after `applied` (for Extract only when the model completed),
//   `no-session` (Extract) and `no-change` (which means the model completed and found nothing).
//   `apply-interrupted` never moves them. For Organize also after `rejected` when the
//   model completed: the same notes would only give the same rejection, so the scope waits until
//   its content changes, or REVISIT_MS while still over the limits. Half-finished edits of a
//   model that did not complete prove nothing, and `model-failed` never moves them, so the
//   conversations are read again and the scope is organized again.
// - Ordering marks: `lastExtractTried` and `lastOrganizeTried` move whenever the model process
//   was started, so a scope that fails or is rejected on every run does not stay first.
function record(config, state, { kind, scope, res, started, dryRun }) {
  const entry = state.projects[scope] ?? (state.projects[scope] = {});
  const completed = res.model?.stopReason === 'completed';
  // An Extract applied after a stop other than `completed` keeps its window: the model may not
  // have reached every conversation, so the same window is read again (the notes it wrote stay).
  let advance = (res.outcome === 'applied' && (kind === 'organize' || completed)) || res.outcome === 'no-change';
  if (kind === 'extract') advance ||= res.outcome === 'no-session';
  else advance ||= res.outcome === 'rejected' && completed;
  if (modelStarted(res) && !dryRun) entry[kind === 'extract' ? 'lastExtractTried' : 'lastOrganizeTried'] = started.toISOString();
  if (advance && !dryRun) {
    if (kind === 'extract') {
      entry.lastExtract = started.toISOString();
    } else if (HASH_RE.test(res.digest ?? '')) {
      entry.lastOrganize = started.toISOString();
      entry.organizedDigest = res.digest;
    }
  }
  entry.lastOutcome = {
    kind, at: new Date().toISOString(), outcome: res.outcome,
    stopReason: res.model?.stopReason ?? null, costUsd: res.model?.costUsd ?? null, denials: res.model?.denials ?? null,
    repairs: res.repairs ?? 0,
  };
  if (res.conversation) {
    entry.lastOutcome.truncated = res.conversation.truncated;
    entry.lastOutcome.sessionsLeftOut = res.conversation.sessionsLeftOut;
  }
  writeState(config, state);
}

function headline(kind, scope, res) {
  let what;
  if (res.outcome === 'rejected') what = `rejected, nothing applied (${res.errors?.length ?? 0} rule violation(s))`;
  else if (res.outcome === 'changed-meanwhile') what = 'changed meanwhile, nothing applied';
  else if (res.outcome === 'aborted') what = 'aborted, nothing applied';
  else if (res.outcome === 'model-failed') what = 'model-failed, nothing applied';
  else if (res.outcome === 'apply-interrupted') what = 'apply interrupted, changes may have been applied';
  else what = `${res.outcome}, ${res.changes?.length ?? 0} change(s)`;
  let line = `${kind} ${scope}: ${what}, ${usd(res.model ? res.model.costUsd : 0)}`;
  if (res.model) line += `, stopped: ${res.model.stopReason}`;
  if (res.model?.denials > 0) line += `, ${res.model.denials} denied tool call(s)`;
  if (res.repairs > 0) line += `, one repair run (${res.firstProblems} problem(s) found first)`;
  if (res.conversation?.truncated) line += ', conversation text cut';
  return line;
}

function printScope(kind, scope, res, opts, repoDir) {
  const lines = [headline(kind, scope, res)];
  if (res.outcome === 'apply-interrupted') {
    lines.push('  - the apply step ended without reporting its result; look at the log of the notes repository'
      + ` (git -C ${repoDir} log) for a consolidate(...) commit, and at its working tree`);
  }
  const errors = (res.errors ?? []).map((e) => `  - ${e}`);
  if (res.outcome === 'sync-failed') {
    const when = res.step === 'apply' ? 'before applying' : 'before the snapshot';
    lines.push(`  - the sync ${when} failed: ${res.sync?.error ?? 'unknown error'}`);
  }
  if (res.outcome === 'error') lines.push(`  - the ${res.step} step failed: ${res.error ?? 'unknown error'}`);
  if (res.outcome === 'step-failed') {
    lines.push(`  - the ${res.step} step could not run${res.lockTimeout ? ': the wait for the sync lock timed out' : ''}`);
  }
  if (res.reason) lines.push(`  - ${res.reason}`);
  if (res.outcome === 'changed-meanwhile') {
    for (const name of res.liveChanged ?? []) lines.push(`  - changed meanwhile: ${name}`);
  }
  if (typeof res.report === 'string') lines.push(res.report.trimEnd());
  if (res.outcome === 'rejected' || (opts.dryRun && errors.length > 0)) lines.push(...errors);
  if (res.outcome === 'applied' && res.reportError) lines.push(`  - the report could not be written: ${res.reportError}`);
  if (res.outcome === 'applied' && res.sync && !res.sync.ok) {
    lines.push(`  - push pending: the sync after applying failed (${res.sync.error ?? 'unknown error'}); the next sync retries`);
  }
  if (opts.keep && res.work) {
    lines.push(`  work folder kept: ${res.work}`, '  it may contain conversation text; delete it when you are done');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function driverMain(argv) {
  const opts = parseDriverArgs(argv);
  if (!opts) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const config = loadConfig();
  // A block that is present but invalid is an error, not "not configured": the weekly unit fails
  // instead of staying green while it does nothing.
  if (config?.consolidateProblem) {
    process.stdout.write(`agent-memory: the consolidate block in ${configPath()} is invalid (${config.consolidateProblem}); nothing was run.\n`);
    return 1;
  }
  if (!config || !config.consolidate) {
    process.stdout.write(`${NOT_CONFIGURED}\n`);
    return 0;
  }
  for (const signal of Object.keys(SIGNAL_CODES)) process.on(signal, onSignal);
  const c = config.consolidate;
  const model = opts.model ?? c.model;
  const started = new Date();
  const now = started.getTime();
  removeStaleRuns(config, now);
  const scanStep = runStep(['scan']);
  const scan = scanStep.result;
  if (await signalsHandled()) {
    process.stdout.write(`${opts.kind}: interrupted by ${interrupted}; nothing was applied\n`);
    return SIGNAL_CODES[interrupted];
  }
  if (!scan || scan.outcome !== 'scan') {
    let why = scan?.outcome === 'error' ? scan.error : 'the scan of the notes could not run';
    if (lockTimedOut(scanStep)) why += ': the wait for the sync lock timed out';
    process.stderr.write(`agent-memory consolidate: ${why}\n`);
    return 1;
  }
  const projects = new Set(scan.projects.map((p) => p.name));
  for (const name of opts.projects) {
    const ok = name === GLOBAL ? scan.global.usable : projects.has(name);
    if (!ok) {
      process.stderr.write(`agent-memory consolidate: ${JSON.stringify(name)} is not a project folder of the notes.\n${USAGE}\n`);
      return 2;
    }
  }
  if ((scan.ignored ?? []).includes(GLOBAL)) {
    process.stdout.write('agent-memory consolidate: projects/global is never consolidated (a project folder may not be named global).\n');
  }

  const state = readState(config, started);
  const list = opts.kind === 'extract' ? extractScopes(scan, state, opts, now) : organizeScopes(scan, state, opts, now);
  const limit = opts.projects.length > 0 ? Infinity : c.maxProjects;
  // The run's cost ceiling: maxBudgetUsd for each scope the run may take, which is maxProjects,
  // or the number of projects named with --project.
  const ceiling = (opts.projects.length > 0 ? opts.projects.length : c.maxProjects) * c.maxBudgetUsd;
  let calls = 0;
  let spent = 0;
  let runDir = null;
  let failed = false;
  try {
    for (const item of list) {
      // A signal during the previous scope's apply step stops the run before the next snapshot.
      if ((await signalsHandled()) || calls >= limit) break;
      if (spent >= ceiling) {
        process.stdout.write(`${opts.kind}: stopped; the model cost of this run reached its ceiling of ${usd(ceiling)}\n`);
        break;
      }
      let digest = null;
      if (opts.kind === 'extract') {
        digest = await buildDigest({ files: item.files, repoDir: config.repoDir, maxBytes: c.maxTranscriptBytes, since: item.since });
        if (interrupted) break;
        if (digest.sessions === 0) {
          const res = { outcome: 'no-session', conversation: conversationOf(digest) };
          record(config, state, { kind: opts.kind, scope: item.scope, res, started, dryRun: opts.dryRun });
          printScope(opts.kind, item.scope, res, opts);
          continue;
        }
      }
      runDir ??= makeRunDir(config, started, opts.keep);
      calls += 1;
      const res = await runScope({ config, opts, model, runDir, scope: item.scope, digest });
      if (digest) res.conversation = conversationOf(digest);
      digest = null;
      spent += spentBy(res, c);
      record(config, state, { kind: opts.kind, scope: item.scope, res, started, dryRun: opts.dryRun });
      printScope(opts.kind, item.scope, res, opts, config.repoDir);
      if (res.outcome === 'aborted') break;
      if (res.outcome === 'step-failed' || res.outcome === 'error' || res.outcome === 'apply-interrupted') {
        failed = true;
        break;
      }
      if (res.outcome === 'sync-failed') {
        process.stdout.write(`${opts.kind}: stopped; the sync failed, and the remaining scopes would wait for it too\n`);
        break;
      }
      // A failed model run makes the whole run fail (exit 1) once the other scopes are done. A
      // command that could not start would fail the same way for every scope: stop now.
      if (res.outcome === 'model-failed') {
        failed = true;
        if (NOT_STARTED.includes(res.model.stopReason)) {
          process.stdout.write(`${opts.kind}: stopped; the model command could not be started (${res.model.stopReason})\n`);
          break;
        }
      }
    }
  } finally {
    if (runDir && !opts.keep) removeTree(runDir);
  }
  if (await signalsHandled()) {
    process.stdout.write(`${opts.kind}: interrupted by ${interrupted}; nothing more was applied\n`);
    return SIGNAL_CODES[interrupted];
  }
  if (list.length === 0) process.stdout.write(`${opts.kind}: nothing to do\n`);
  return failed ? 1 : 0;
}

const argv = process.argv.slice(2);
if (argv[0] === '--step') {
  process.exitCode = stepMain(argv.slice(1));
} else {
  driverMain(argv).then((code) => {
    process.exitCode = code;
  }, (err) => {
    process.stderr.write(`agent-memory consolidate failed: ${firstLine(err)}\n`);
    process.exitCode = 1;
  });
}
