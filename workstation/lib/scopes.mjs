// The scopes of the notes clone: `global/` and the project folders under `projects/`. Which folders a
// consolidation run may take, what a scan says of each, and Organize's rule for which are due. File
// reads only (no Git, no model, no network), so that the read-only `consolidate report` judges the
// backlog with the very rule that Organize uses.

import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { digestOfFiles, digestsOf } from './label-notes.mjs';
import { INDEX, indexStats } from './notes.mjs';
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
