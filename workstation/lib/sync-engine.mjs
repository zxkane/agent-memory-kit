// Commits local note changes, merges origin/main and pushes. The only module that runs Git
// on the notes clone. runSync never throws; every failure becomes { ok: false, error }.
import { randomBytes } from 'node:crypto';
import {
  appendFileSync, chmodSync, copyFileSync, constants, existsSync, lstatSync, mkdirSync,
  readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { firstErrorLine, git, TIMEOUT_CODE } from './git.mjs';
import { PROJECT_MARKER } from './identity.mjs';
import { mergeIndex } from './link.mjs';
import { scanText } from './secret-scan.mjs';

const BRANCH = 'main';
const INDEX = 'MEMORY.md';
// Larger files are never committed; everything up to this size is scanned.
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const OVERSIZE = 'oversize';
const DEFAULT_PUSH_ATTEMPTS = 3;
const NETWORK_TIMEOUT_MS = 60_000;
const STALE_INDEX_LOCK_MS = 60_000;
// Lossy on purpose: a stray invalid byte must not exempt a file from the scan.
const lossyUtf8 = new TextDecoder('utf-8');
const PRIVATE_KEY_END_RE = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const GITLINK_MODE = '160000';

const identity = (host) => ['-c', 'user.name=agent-memory-sync', '-c', `user.email=agent-memory-sync@${host}.invalid`];
const nulList = (out) => out.split('\0').filter(Boolean);
const stampOf = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const quarantineDir = (config) => join(config.stateDir, 'quarantine');

export function conflictName(relPath, host, exists) {
  const dir = posix.dirname(relPath);
  const base = posix.basename(relPath);
  const dot = base.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ''];
  const prefix = dir === '.' ? '' : `${dir}/`;
  for (let n = 1; ; n++) {
    const candidate = `${prefix}${stem}.conflict-${host}${n === 1 ? '' : `-${n}`}${ext}`;
    if (!exists(candidate)) return candidate;
  }
}

// Fails closed: content is scanned through a lossy UTF-8 decode, and content over
// MAX_FILE_BYTES is flagged as oversize without being read.
function inspectContent(size, readBuffer) {
  if (size > MAX_FILE_BYTES) return { text: null, oversize: true, findings: [] };
  const text = lossyUtf8.decode(readBuffer());
  return { text, oversize: false, findings: scanText(text) };
}

const isFlagged = (r) => r.oversize || r.findings.length > 0;
const flaggedIds = (r) => (r.oversize ? [OVERSIZE] : [...new Set(r.findings.map((f) => f.id))]);

// Inspection of a working file, or null when it is not a regular file.
function inspectWorkingFile(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return null;
  }
  return stat.isFile() ? inspectContent(stat.size, () => readFileSync(file)) : null;
}

// Inspection of a blob read from Git. A blob that cannot be read fails the run (fail closed).
function inspectBlob(repo, object) {
  const size = Number(git(repo, ['cat-file', '-s', object]).stdout.trim());
  return inspectContent(size, () => git(repo, ['cat-file', 'blob', object], { buffer: true }).stdout);
}

function ensureQuarantineDir(config) {
  const dir = quarantineDir(config);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

// The quarantine copy is made before the original is touched, so a crash in between leaves
// two copies rather than none.
function copyToQuarantine(src, dest) {
  copyFileSync(src, dest, constants.COPYFILE_EXCL);
  chmodSync(dest, 0o600);
}

// Replaces a file in the clone through a temporary name that the notes repository ignores
// (`*.tmp.*`), so a crash never leaves a partly written index.
function replaceFile(file, text) {
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function uniquePath(path) {
  let candidate = path;
  for (let n = 2; existsSync(candidate); n++) candidate = `${path}-${n}`;
  return candidate;
}

// Changes from `git diff --raw -z <diffArgs>` as { mode, object, status, path } of the new side.
function rawChanges(repo, diffArgs) {
  const fields = nulList(git(repo, ['diff', '--raw', '--no-renames', '--no-abbrev', '-z', ...diffArgs]).stdout);
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode, , object, status] = fields[i].split(' ');
    out.push({ mode, object, status, path: fields[i + 1] });
  }
  return out;
}

const stagedChanges = (repo) => rawChanges(repo, ['--cached']);
// Gitlinks are commit ids, not content that a push sends.
const addedOrModified = (changes) => changes.filter((c) => /^[AMT]/.test(c.status) && c.mode !== GITLINK_MODE);

// 1-based line numbers to remove: each flagged line and, for a private key, every line from
// BEGIN through the matching END line (or to the end of the text when there is none).
function linesToRemove(lines, findings) {
  // A trailing newline leaves an empty last element that is not a line of its own.
  const last = lines.at(-1) === '' ? lines.length - 1 : lines.length;
  const remove = new Set();
  for (const { id, line } of findings) {
    remove.add(line);
    if (id !== 'private-key-block') continue;
    for (let n = line; n <= last; n++) {
      remove.add(n);
      if (PRIVATE_KEY_END_RE.test(lines[n - 1])) break;
    }
  }
  return remove;
}

// Removes the flagged lines from the same text that was scanned and writes the rest back.
// The removed lines are saved to quarantine first.
function quarantineIndexLines(config, repo, rel, text, findings, stamp) {
  const lines = text.split('\n');
  const flagged = linesToRemove(lines, findings);
  const removed = lines.filter((_, i) => flagged.has(i + 1));
  const dest = join(ensureQuarantineDir(config), `${stamp}__${rel.replaceAll('/', '__')}.lines`);
  appendFileSync(dest, `${removed.join('\n')}\n`, { mode: 0o600 });
  chmodSync(dest, 0o600);
  replaceFile(join(repo, rel), lines.filter((_, i) => !flagged.has(i + 1)).join('\n'));
  git(repo, ['add', '--', rel]);
}

function dropIndexLinks(repo, rel) {
  const indexRel = posix.join(posix.dirname(rel), INDEX);
  const file = join(repo, indexRel);
  if (!existsSync(file)) return;
  const needle = `](${posix.basename(rel)})`;
  const text = readFileSync(file, 'utf8');
  const kept = text.split('\n').filter((line) => !line.includes(needle)).join('\n');
  if (kept === text) return;
  replaceFile(file, kept);
  git(repo, ['add', '--', indexRel]);
}

// Copies the flagged file into quarantine, then restores the committed version or, for a
// new file, removes it and its index lines.
function quarantineFile(config, repo, rel, stamp) {
  const dest = uniquePath(join(ensureQuarantineDir(config), `${stamp}__${rel.replaceAll('/', '__')}`));
  copyToQuarantine(join(repo, rel), dest);
  if (git(repo, ['cat-file', '-e', `HEAD:${rel}`], { allowFail: true }).code === 0) {
    git(repo, ['checkout', 'HEAD', '--', rel]);
  } else {
    git(repo, ['rm', '-q', '--cached', '--ignore-unmatch', '--', rel]);
    unlinkSync(join(repo, rel));
    dropIndexLinks(repo, rel);
  }
}

// Step 3: scan every staged addition or modification and quarantine what is flagged.
function quarantineSecrets(config, repo, stamp) {
  const quarantined = [];
  for (const { path: rel } of addedOrModified(stagedChanges(repo))) {
    const inspection = inspectWorkingFile(join(repo, rel));
    if (!inspection || !isFlagged(inspection)) continue;
    if (posix.basename(rel) === INDEX && !inspection.oversize) {
      quarantineIndexLines(config, repo, rel, inspection.text, inspection.findings, stamp);
    } else {
      quarantineFile(config, repo, rel, stamp);
    }
    quarantined.push(rel);
  }
  // A session may rewrite a file between `git add` and the scan above. Check what is actually
  // staged and leave anything flagged out of this commit; the next run handles it.
  for (const { path: rel, object } of addedOrModified(stagedChanges(repo))) {
    if (!isFlagged(inspectBlob(repo, object))) continue;
    git(repo, ['reset', '-q', '--', rel]);
    if (!quarantined.includes(rel)) quarantined.push(rel);
  }
  return quarantined;
}

const OBJECT_LINE_RE = /^([0-9a-f]{40}|[0-9a-f]{64})(?: (.*))?$/;

// Blobs the push would introduce: reachable from HEAD but not from origin/main, from any commit
// in the range, each listed once. Uses only options available in Git 2.30 (no `rev-list -z`, no
// `--filter=object:type`). Each line starts with a full object id; the rest is the path, which
// is used only in the error message. Git ends a listed name at a newline, so a file name that
// contains one shows up shortened there; lines that do not start with an object id are ignored.
// The scan itself goes by object id and never depends on the path text.
function unpushedBlobs(repo) {
  const paths = new Map();
  for (const line of git(repo, ['rev-list', '--objects', 'origin/main..HEAD']).stdout.split('\n')) {
    const m = OBJECT_LINE_RE.exec(line);
    if (m && !paths.has(m[1])) paths.set(m[1], m[2] ?? '');
  }
  if (paths.size === 0) return [];
  // One batch call types every listed object (commits, trees and blobs) and gives blob sizes.
  const input = `${[...paths.keys()].join('\n')}\n`;
  const checks = git(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input }).stdout;
  const blobs = [];
  for (const line of checks.split('\n')) {
    const [object, type, size] = line.split(' ');
    if (!object) continue;
    // `<id> missing`: content that would be pushed cannot be checked, so fail closed.
    if (type === undefined || type === 'missing') throw new Error(`cannot read object ${object}`);
    if (type === 'blob') blobs.push({ object, size: Number(size), path: paths.get(object) });
  }
  return blobs;
}

// Everything the push sends must pass the same rules as a commit. Returns null, or the
// refusal naming paths and pattern ids only.
function pushRefusal(repo) {
  const flagged = new Map();
  for (const { path: rel, object, size } of unpushedBlobs(repo)) {
    const inspection = inspectContent(size, () => git(repo, ['cat-file', 'blob', object], { buffer: true }).stdout);
    if (!isFlagged(inspection)) continue;
    if (!flagged.has(rel)) flagged.set(rel, new Set());
    for (const id of flaggedIds(inspection)) flagged.get(rel).add(id);
  }
  if (flagged.size === 0) return null;
  const list = [...flagged].map(([rel, ids]) => `${rel} (${[...ids].join(', ')})`);
  return `unpushed commits contain flagged content: ${list.join('; ')}`;
}

// A run killed during `git add` or `git commit` leaves index.lock behind. The caller holds the
// sync lock and nothing else runs Git in this clone, so an old lock is stale.
function removeStaleIndexLock(repo) {
  const out = git(repo, ['rev-parse', '--git-path', 'index.lock']).stdout.trim();
  const lock = isAbsolute(out) ? out : join(repo, out);
  try {
    if (Date.now() - lstatSync(lock).mtimeMs > STALE_INDEX_LOCK_MS) unlinkSync(lock);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function unmergedPaths(repo) {
  const byPath = new Map();
  for (const entry of nulList(git(repo, ['ls-files', '-u', '-z']).stdout)) {
    const tab = entry.indexOf('\t');
    const stage = Number(entry.slice(0, tab).split(' ')[2]);
    const path = entry.slice(tab + 1);
    if (!byPath.has(path)) byPath.set(path, new Set());
    byPath.get(path).add(stage);
  }
  return byPath;
}

// Stage 2 is the local side, stage 3 the remote side. A note changed on both sides is
// recorded in result.conflicts; a project marker claimed differently on both sides keeps
// the remote's identity, gets no copy, and its folder is recorded in result.markerConflicts.
function resolveUnmerged(repo, host, rel, stages, result) {
  const local = stages.has(2);
  const remote = stages.has(3);
  if (local && remote && posix.basename(rel) === INDEX) {
    const side = (n) => git(repo, ['cat-file', 'blob', `:${n}:${rel}`]).stdout;
    writeFileSync(join(repo, rel), mergeIndex(side(2), side(3), new Map()));
    git(repo, ['add', '--', rel]);
    return;
  }
  if (local && remote && posix.basename(rel) === PROJECT_MARKER) {
    git(repo, ['checkout', '--theirs', '--', rel]);
    git(repo, ['add', '--', rel]);
    result.markerConflicts.push(posix.dirname(rel));
    return;
  }
  if (local && remote) {
    const copy = conflictName(rel, host, (p) => existsSync(join(repo, p)));
    git(repo, ['checkout', '--ours', '--', rel]);
    renameSync(join(repo, rel), join(repo, copy));
    git(repo, ['checkout', '--theirs', '--', rel]);
    git(repo, ['add', '--', rel, copy]);
    result.conflicts.push(rel);
    return;
  }
  if (local || remote) {
    git(repo, ['checkout', local ? '--ours' : '--theirs', '--', rel]);
    git(repo, ['add', '--', rel]);
    return;
  }
  git(repo, ['rm', '-q', '--cached', '--', rel]);
}

function mergeRemote(repo, host, result) {
  const message = `sync(${host}): merge origin/main`;
  const merge = git(repo, [...identity(host), 'merge', '--no-edit', '-m', message, 'origin/main'], { allowFail: true });
  if (merge.code === 0) return;
  const unmerged = unmergedPaths(repo);
  if (unmerged.size === 0) throw new Error(firstErrorLine(merge.stderr) || 'merge failed');
  for (const [rel, stages] of unmerged) resolveUnmerged(repo, host, rel, stages, result);
  git(repo, [...identity(host), 'commit', '-q', '--no-edit', '-m', message]);
}

const revParse = (repo, ref) => git(repo, ['rev-parse', '--verify', '-q', ref], { allowFail: true }).stdout.trim();
const isAncestor = (repo, a, b) => git(repo, ['merge-base', '--is-ancestor', a, b], { allowFail: true }).code === 0;
const mergeInProgress = (repo) => revParse(repo, 'MERGE_HEAD') !== '';
const TRACKING_REF = `refs/remotes/origin/${BRANCH}`;

// Fetches the remote branch without moving origin/main, and moves it only when the remote
// still contains what was fetched before. A rewritten remote history is refused, every run,
// until the clone is replaced: merging it would push the removed commits back.
function fetchRemote(repo, timeoutMs) {
  const before = revParse(repo, TRACKING_REF);
  const fetch = git(repo, ['fetch', '-q', '--refmap=', 'origin', `refs/heads/${BRANCH}`], { allowFail: true, timeoutMs });
  if (fetch.code !== 0) throw new Error(firstErrorLine(fetch.stderr) || 'fetch failed');
  const fetched = revParse(repo, 'FETCH_HEAD');
  if (fetched === '') throw new Error('fetch failed');
  if (before !== '' && before !== fetched && !isAncestor(repo, before, fetched)) {
    throw new Error(`remote history was rewritten; re-clone ${repo} (see README)`);
  }
  git(repo, ['update-ref', TRACKING_REF, fetched]);
}

function checkRepo(repo) {
  const top = git(repo, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (top.code !== 0) throw new Error(`${repo} is not a Git work tree`);
  if (realpathSync(top.stdout.trim()) !== realpathSync(repo)) throw new Error(`${repo} is not the top of a Git work tree`);
  const branch = git(repo, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true }).stdout.trim();
  if (branch !== BRANCH) throw new Error(`clone is on ${branch || 'a detached HEAD'}, not ${BRANCH}`);
}

// Stages the working tree, quarantines flagged content and commits the rest. Returns the
// number of files committed. `message`, when given, replaces the default subject.
function commitWorkingTree(config, repo, stamp, result, message) {
  git(repo, ['add', '-A']);
  for (const rel of quarantineSecrets(config, repo, stamp)) {
    if (!result.quarantined.includes(rel)) result.quarantined.push(rel);
  }
  const staged = stagedChanges(repo).length;
  const subject = message ? `${message} (${staged} file(s))` : `sync(${config.host}): ${staged} file(s)`;
  if (staged > 0) git(repo, [...identity(config.host), 'commit', '-q', '-m', subject]);
  return staged;
}

// `opts.message`, a non-empty single-line string, is the subject of the working-tree commit
// (followed by the file count). `opts.afterRebuild` lets tests act right after the rebuild commit.
export function runSync(config, opts = {}) {
  const result = {
    ok: false, committed: 0, merged: false, pushed: false, quarantined: [], conflicts: [], markerConflicts: [], error: null,
  };
  const repo = config.repoDir;
  const host = config.host;
  const maxPushAttempts = opts.maxPushAttempts ?? DEFAULT_PUSH_ATTEMPTS;
  const timeoutMs = opts.networkTimeoutMs ?? NETWORK_TIMEOUT_MS;
  const stamp = stampOf(opts.now ?? new Date());
  const message = typeof opts.message === 'string' && opts.message !== '' && !/[\r\n]/.test(opts.message)
    ? opts.message : null;
  try {
    checkRepo(repo);
    removeStaleIndexLock(repo);
    if (mergeInProgress(repo)) git(repo, ['merge', '--abort']);

    result.committed = commitWorkingTree(config, repo, stamp, result, message);

    let rebuilt = false;
    for (let attempt = 1; attempt <= maxPushAttempts; attempt++) {
      fetchRemote(repo, timeoutMs);
      if (!isAncestor(repo, 'origin/main', 'HEAD')) {
        mergeRemote(repo, host, result);
        result.merged = true;
      }
      if (revParse(repo, 'HEAD') === revParse(repo, 'origin/main')) break;
      let refusal = pushRefusal(repo);
      if (refusal !== null && !rebuilt) {
        // Flagged content in unpushed commits (a hand commit, or a merge that folded a flagged
        // remote line into a new version). Rebuild those commits once from the working tree,
        // which is kept, so that the usual scan and quarantine apply to them.
        rebuilt = true;
        git(repo, ['reset', '-q', '--mixed', 'origin/main']);
        result.committed = commitWorkingTree(config, repo, stamp, result, message);
        opts.afterRebuild?.();
        if (revParse(repo, 'HEAD') === revParse(repo, 'origin/main')) break;
        refusal = pushRefusal(repo);
      }
      if (refusal !== null) throw new Error(refusal);
      const head = revParse(repo, 'HEAD');
      const push = git(repo, ['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`], { allowFail: true, timeoutMs });
      if (push.code === 0) {
        git(repo, ['update-ref', `refs/remotes/origin/${BRANCH}`, head]);
        result.pushed = true;
        break;
      }
      // A stalled push is not retried: further attempts would outlast the unit's time limit.
      if (push.code === TIMEOUT_CODE) throw new Error(firstErrorLine(push.stderr));
      result.error = `push rejected: ${firstErrorLine(push.stderr) || 'push failed'}`;
    }

    if (revParse(repo, 'HEAD') === revParse(repo, 'origin/main')) {
      result.ok = true;
      result.error = null;
    } else {
      result.error ??= 'HEAD differs from origin/main';
    }
  } catch (err) {
    result.ok = false;
    result.error = String(err?.message ?? err).split('\n')[0] || 'sync failed';
    try {
      if (mergeInProgress(repo)) git(repo, ['merge', '--abort'], { allowFail: true });
    } catch {
      // The next run aborts it.
    }
  }
  return result;
}

const statusFile = (config) => join(config.stateDir, 'status.json');

export function readStatus(config) {
  try {
    return JSON.parse(readFileSync(statusFile(config), 'utf8'));
  } catch {
    return null;
  }
}

function countQuarantine(config) {
  try {
    return readdirSync(quarantineDir(config)).length;
  } catch {
    return 0;
  }
}

// Pathspecs are literal (see git.mjs), so tracked files are listed and matched here.
const CONFLICT_COPY_RE = /\.conflict-[^/]*\.md$/;

function countConflicts(config) {
  const r = git(config.repoDir, ['ls-files', '-z'], { allowFail: true });
  return r.code === 0 ? nulList(r.stdout).filter((p) => CONFLICT_COPY_RE.test(p)).length : 0;
}

const asList = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);

export function writeStatus(config, result, now = new Date()) {
  const previous = readStatus(config);
  const lastRun = now.toISOString();
  const status = {
    ...result,
    lastRun,
    lastSuccess: result.ok ? lastRun : (previous?.lastSuccess ?? null),
    quarantineCount: countQuarantine(config),
    conflictCount: countConflicts(config),
    // Kept from every run until the person deletes status.json.
    markerConflicts: [...new Set([...asList(previous?.markerConflicts), ...asList(result.markerConflicts)])].sort(),
  };
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const file = statusFile(config);
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return status;
}
