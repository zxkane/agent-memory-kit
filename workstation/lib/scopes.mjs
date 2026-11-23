// The scopes of the notes clone: `global/` and the project folders under `projects/`. Which folders a
// consolidation run may take, what a scan says of each, and Organize's rule for which are due. File
// reads only (no Git, no model, no network), so that the read-only `consolidate report` judges the
// backlog with the very rule that Organize uses.

import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { digestOfFiles, digestsOf } from './label-notes.mjs';
import { INDEX, indexStats } from './notes.mjs';
import { filesChangedSince, sessionFilesSince } from './transcripts.mjs';
import { noteFiles } from './workdir.mjs';

export const GLOBAL = 'global';
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25000;
const DAY_MS = 24 * 3600 * 1000;
// How long an unchanged scope that Organize could not bring within the limits waits before it is due again.
export const REVISIT_MS = 28 * DAY_MS;
const CONFLICT_RE = /\.conflict-[^/]*\.md$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const isMissing = (err) => err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A folder name the driver may use as a project scope: no separator, not hidden, printable.
// A project folder named `global` would be confused with the global scope and is never used.
export function isPlainName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200 && !name.includes('/')
    && !name.startsWith('.') && !CONTROL_RE.test(name) && name !== GLOBAL;
}

export function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

// What the scan says of a scope folder: its notes, whether its index is over a limit or it holds a
// conflict copy, and the digest of its note files.
export function scopeInfo(dir) {
  const files = noteFiles(dir);
  const index = files.get(INDEX);
  const stats = indexStats(index ? index.toString('utf8') : '');
  const names = [...files.keys()];
  return {
    notes: names.filter((n) => n !== INDEX).length,
    overLimit: stats.lines > INDEX_MAX_LINES || stats.bytes > INDEX_MAX_BYTES,
    conflict: names.some((n) => CONFLICT_RE.test(n)),
    digest: digestOfFiles(digestsOf(files)),
  };
}

// ---- Folders of the clone that a run may touch ----

export function projectsDir(config) {
  const dir = join(config.repoDir, 'projects');
  return lstatOrNull(dir)?.isDirectory() ? dir : null;
}

// Plain, real folders directly under <repoDir>/projects.
export function listProjects(config) {
  const dir = projectsDir(config);
  if (!dir) return [];
  return readdirSync(dir).filter((n) => isPlainName(n) && lstatOrNull(join(dir, n))?.isDirectory()).sort(byName);
}

// The live folder of a scope, or null when it may not be touched. global/ may be missing (an
// apply creates it); a project folder must exist.
export function liveFolder(config, scope) {
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

// The folder of a scope in the clone, as the label step and the paths of its notes name it:
// `global`, or `projects/<name>` for a scope named as consolidate.json names it.
export const scopeFolder = (name) => (name === GLOBAL ? GLOBAL : `projects/${name}`);

// Why the configured clone cannot be used, or null.
export function cloneProblem(config) {
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

export const timeOf = (iso) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

// Extract's session window of a project that was never extracted starts this far back; no window
// reaches back further than EXTRACT_MAX_WINDOW_MS.
export const EXTRACT_LOOKBACK_MS = 7 * DAY_MS;
export const EXTRACT_MAX_WINDOW_MS = 28 * DAY_MS;

// Where Extract's session window of a project starts at `now` (ms): at its last Extract (`entry`
// being its record in consolidate.json, or none), EXTRACT_LOOKBACK_MS back when it was never
// extracted; at `since` (ms), when the run was given a start, if that is earlier (a start can move
// the window back, never forward, which would skip what it has not read); but never more than
// EXTRACT_MAX_WINDOW_MS back (a run that stopped early keeps lastExtract, and the window must not
// grow without end).
export function extractWindowStart(entry, now, since = null) {
  const last = timeOf(entry?.lastExtract);
  const usual = last === null ? now - EXTRACT_LOOKBACK_MS : last;
  return Math.max(since === null ? usual : Math.min(since, usual), now - EXTRACT_MAX_WINDOW_MS);
}

// The projects Extract takes and their order, for a run and for the report alike: each project of
// `names` with a conversation file that changed since the start of its window (`sessions` maps a
// project to its Claude Code folders, `codex` to its Codex files), as `{ scope, files, since,
// newest, tried, last }`. The one whose model run was tried longest ago goes first (never tried
// first, which includes state written before `lastExtractTried` existed), so that every project gets
// its turn across runs even when one is rejected every time; then the oldest session window, then
// the newest session. With `named` (projects named on the command line), exactly those, in their
// order, also without files.
export function extractCandidates({ names, sessions, codex, state, now, since = null, named = [] }) {
  const list = [];
  for (const scope of named.length > 0 ? named : names) {
    const entry = state.projects[scope];
    const start = extractWindowStart(entry, now, since);
    const files = [
      ...sessionFilesSince(sessions.get(scope) ?? [], start).map((file) => ({ tool: 'claude', file })),
      ...filesChangedSince(codex.get(scope) ?? [], start).map((file) => ({ tool: 'codex', file })),
    ];
    if (named.length === 0 && files.length === 0) continue;
    let newest = 0;
    for (const { file } of files) {
      try {
        newest = Math.max(newest, statSync(file).mtimeMs);
      } catch {
        // Vanished: does not count.
      }
    }
    list.push({ scope, files, since: start, newest, tried: timeOf(entry?.lastExtractTried) ?? -Infinity, last: timeOf(entry?.lastExtract) ?? -Infinity });
  }
  const older = (a, b) => (a === b ? 0 : a - b);
  if (named.length === 0) list.sort((x, y) => older(x.tried, y.tried) || older(x.last, y.last) || y.newest - x.newest || byName(x.scope, y.scope));
  return list;
}

// Whether a scope's record in consolidate.json (or none) says it was never organized: it holds no
// time of a last organize.
export const neverOrganized = (entry) => timeOf(entry?.lastOrganize) === null;

// Why a scope is due for Organize at `now` (ms), or null when it is not. `info` is what scopeInfo
// says of it, `entry` its record in consolidate.json (or none). A scope with notes is due when its
// content changed since it was last organized (`changed`), or it never was (`never-organized`, as
// neverOrganized says). One
// that did not change but is still over the index limits (`over-limits`) or still holds a conflict
// copy (`conflict`) is due again only after REVISIT_MS: the model could not fix it last time, and
// taking it every week would crowd out the scopes that changed.
export function organizeDue(info, entry, now) {
  if (info.notes === 0) return null;
  if (info.digest !== entry?.organizedDigest) return neverOrganized(entry) ? 'never-organized' : 'changed';
  if (!info.overLimit && !info.conflict) return null;
  const last = timeOf(entry?.lastOrganize) ?? -Infinity;
  if (now - last <= REVISIT_MS) return null;
  return info.overLimit ? 'over-limits' : 'conflict';
}

// Organize: the due scopes (organizeDue), in two groups:
// - A, every due scope except those of group B: by class (over the limits, then a conflict copy,
//   then the others), then by lastOrganizeTried (falling back to lastOrganize), oldest first,
//   never tried first;
// - B, scopes whose last model run left them unorganized (lastOrganizeTried is set and lastOrganize
//   is absent or older) within the last REVISIT_MS: after all of A, by lastOrganizeTried only,
//   whatever their class, so that scopes failing every run rotate among themselves and cannot keep
//   the others waiting. A failed try older than REVISIT_MS puts the scope back into group A, at the
//   front of its class, so that it waits behind the others for at most REVISIT_MS.
export function organizeScopes(scan, state, opts, now) {
  const infos = [...(scan.global.usable ? [{ name: GLOBAL, ...scan.global }] : []), ...scan.projects];
  if (opts.projects.length > 0) return opts.projects.map((name) => ({ scope: name }));
  const entry = (i) => state.projects[i.name];
  const last = (i) => timeOf(entry(i)?.lastOrganize) ?? -Infinity;
  const isDue = (i) => organizeDue(i, entry(i), now) !== null;
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

// The order in which an Organize run takes the scopes of `list` (organizeScopes), of which it
// takes the first `limit`: global/ after the project scopes it takes. A project's Organize may add
// notes to global/, and global/ organized first would be due again at the next run. Only when
// global/ runs changes, not whether: the run takes the same scopes.
export function globalLast(list, limit) {
  const taken = Math.min(limit, list.length);
  const at = list.findIndex((item) => item.scope === GLOBAL);
  if (at < 0 || at >= taken) return list;
  const out = list.filter((_, i) => i !== at);
  out.splice(taken - 1, 0, list[at]);
  return out;
}
