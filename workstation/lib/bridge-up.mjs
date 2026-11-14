// Bridge up: copies the committed notes of this machine to the bucket (`mem/<path>`), rebuilds the
// search snapshot (`index/mem.json`) and records the synced commit (`index/bridge.json`) with a
// conditional write. Every byte sent comes from Git objects of the commit that is HEAD; the
// working tree is never read. The caller guarantees that the sync that came before succeeded.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AwsError } from './aws.mjs';
import { GitError, TIMEOUT_CODE, git } from './git.mjs';
import { INDEX, parseNote } from './notes.mjs';
import { scanText } from './secret-scan.mjs';

// The API's path rules (api/src/validate.ts), copied character for character; a test compares them.
export const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,196}\.md$/;

const MAX_FILE_BYTES = 1_000_000;
const MAX_BODY_BYTES = 100_000;
const CONCURRENCY = 8;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const RECORD_KEY = 'index/bridge.json';
const SNAPSHOT_KEY = 'index/mem.json';
const NOTE_TYPE = 'text/markdown; charset=utf-8';

// `global/<file>` or `projects/<project>/<file>`: the only paths that ever become a key.
export function isMemPath(path) {
  if (typeof path !== 'string') return false;
  const parts = path.split('/');
  if (parts.length === 2) return parts[0] === 'global' && FILE_RE.test(parts[1]);
  if (parts.length === 3) return parts[0] === 'projects' && PROJECT_RE.test(parts[1]) && FILE_RE.test(parts[2]);
  return false;
}

const md5Quoted = (body) => `"${createHash('md5').update(body).digest('hex')}"`;

function checkSignal(signal) {
  if (signal?.aborted) throw new AwsError('bridge-up', 0, 'TimeLimit');
}

const MIN_NETWORK_MS = 2_000;

// The time limit of a blocking Git network command: its own `limitMs`, cut to what is left before
// the caller's `deadline` (epoch milliseconds). With less than MIN_NETWORK_MS left the command is
// not started and the step ends with the time-limit error. Without a deadline, or with one that is not
// a finite number: `limitMs`.
export function networkLimit(limitMs, deadline) {
  if (!Number.isFinite(deadline)) return limitMs;
  const left = deadline - Date.now();
  if (left < MIN_NETWORK_MS) throw new AwsError('bridge-up', 0, 'TimeLimit');
  return Math.min(limitMs, left);
}

// Regular files (not links, not submodules) at `commit` whose path is a mem path, with their
// object size, from one `git ls-tree`. Paths are NUL-separated, so any byte but NUL is safe.
function memFiles(repoDir, commit) {
  const out = git(repoDir, ['ls-tree', '-r', '-z', '-l', commit]).stdout;
  const files = new Map();
  for (const entry of out.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, , size] = entry.slice(0, tab).split(/ +/);
    const path = entry.slice(tab + 1);
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) continue;
    if (!isMemPath(path)) continue;
    files.set(path, Number(size));
  }
  return files;
}

// Reads the content of every path at `commit` with one `git cat-file --batch`.
function readBlobs(repoDir, commit, paths) {
  const contents = new Map();
  if (paths.length === 0) return contents;
  const input = paths.map((p) => `${commit}:${p}\n`).join('');
  const out = git(repoDir, ['cat-file', '--batch'], { input, buffer: true }).stdout;
  let pos = 0;
  for (const path of paths) {
    const end = out.indexOf(0x0a, pos);
    const header = end < 0 ? [] : out.subarray(pos, end).toString('latin1').split(' ');
    const size = Number(header[2]);
    if (header[1] !== 'blob' || !Number.isSafeInteger(size) || end + 1 + size > out.length) {
      throw new Error('git cat-file returned an unexpected answer');
    }
    contents.set(path, out.subarray(end + 1, end + 1 + size));
    pos = end + 1 + size + 1;
  }
  return contents;
}

// The text after the frontmatter block parseNote reads; the whole text when there is none.
function bodyOf(text) {
  const m = /^---\r?\n(?:[^\n]*\n)*?---(?:\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length).replace(/^(?:\r?\n)+/, '') : text;
}

// At most `max` bytes of UTF-8, never splitting a character.
function cutUtf8(text, max) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

const MIN_BODY_BYTES = 2_000;
const SNAPSHOT_MAX_BYTES = 7_000_000; // the API refuses an object over 8 MiB

// The snapshot with the largest per-note body limit (100,000 bytes, reduced by a quarter per step down to 2,000) that
// keeps it within `maxBytes`. Throws SnapshotTooLarge when even the smallest limit does not fit.
function fitSnapshot(commit, contents, maxBytes = SNAPSHOT_MAX_BYTES) {
  const entries = [...contents.keys()].filter((p) => !p.endsWith(`/${INDEX}`)).sort().map((path) => {
    const text = contents.get(path).toString('utf8');
    const meta = parseNote(text);
    const stem = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
    return { path, name: meta.name || stem, description: meta.description ?? '', type: meta.type ?? '', body: bodyOf(text) };
  });
  for (let bodyLimit = MAX_BODY_BYTES; ; bodyLimit = Math.max(MIN_BODY_BYTES, Math.floor((bodyLimit * 3) / 4))) {
    const notes = entries.map((e) => ({ ...e, body: cutUtf8(e.body, bodyLimit) }));
    const json = JSON.stringify({ version: 1, commit, notes });
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes <= maxBytes) return { json, bytes, bodyLimit };
    if (bodyLimit === MIN_BODY_BYTES) throw new AwsError('bridge-up', 0, 'SnapshotTooLarge');
  }
}

// The search snapshot of the mem paths at `commit`, except MEMORY.md files and those in `skip`.
export function buildSnapshot(repoDir, commit, skip = new Set(), { maxBytes = SNAPSHOT_MAX_BYTES } = {}) {
  const paths = [...memFiles(repoDir, commit).keys()].filter((p) => !p.endsWith(`/${INDEX}`) && !skip.has(p));
  return fitSnapshot(commit, readBlobs(repoDir, commit, paths), maxBytes).json;
}

function isAncestor(repoDir, ancestor, commit) {
  const args = ['merge-base', '--is-ancestor', ancestor, commit];
  const res = git(repoDir, args, { allowFail: true });
  if (res.code !== 0 && res.code !== 1) throw new GitError(args, res);
  return res.code === 0;
}

// How the recorded commit relates to head: unknown to the clone, unusable (the hash names an
// object that is not a commit), behind (head is its ancestor), ahead (it is head's ancestor, so a
// delta can start there) or diverged.
function relation(repoDir, recorded, head) {
  const type = git(repoDir, ['cat-file', '-t', recorded], { allowFail: true });
  if (type.code !== 0) return 'unknown';
  if (type.stdout.trim() !== 'commit') return 'unusable';
  if (isAncestor(repoDir, head, recorded)) return 'behind';
  return isAncestor(repoDir, recorded, head) ? 'ahead' : 'diverged';
}

// Fetches the remote branch (objects only: no ref is moved, as in the sync, which compares
// origin/main with what it fetched to detect a rewritten remote) and returns the fetched tip.
function fetchTip(repoDir, signal, deadline) {
  const timeoutMs = networkLimit(20_000, deadline);
  const fetched = git(repoDir, ['fetch', '-q', '--no-auto-maintenance', '--refmap=', 'origin', 'refs/heads/main'], { timeoutMs, allowFail: true });
  if (fetched.code === TIMEOUT_CODE && Number.isFinite(deadline) && timeoutMs < 20_000) throw new AwsError('bridge-up', 0, 'TimeLimit');
  if (fetched.code !== 0) throw new GitError(['fetch'], fetched);
  checkSignal(signal);
  const tip = git(repoDir, ['rev-parse', '--verify', '-q', 'FETCH_HEAD^{commit}'], { allowFail: true }).stdout.trim();
  if (!COMMIT_RE.test(tip)) throw new Error('fetch failed');
  return tip;
}

// `{ changed, removed }`: the mem paths added, modified or retyped, and those deleted.
function delta(repoDir, base, head) {
  const tokens = git(repoDir, ['diff-tree', '-r', '--name-status', '-z', '--no-renames', base, head]).stdout.split('\0');
  const changed = new Set();
  const removed = new Set();
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const path = tokens[i + 1];
    if (!isMemPath(path)) continue;
    (tokens[i] === 'D' ? removed : changed).add(path);
  }
  return { changed, removed };
}

function parseRecord(body) {
  try {
    const r = JSON.parse(body.toString('utf8'));
    const shaped = r !== null && typeof r === 'object' && !Array.isArray(r) && r.version === 1 &&
      typeof r.commit === 'string' && COMMIT_RE.test(r.commit) && typeof r.host === 'string' && typeof r.time === 'string';
    return shaped ? { commit: r.commit } : null;
  } catch {
    return null;
  }
}

export function readState(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    return state !== null && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

function freshSince(state, head, now, recheckMs) {
  const up = state.up;
  if (up === null || typeof up !== 'object' || up.commit !== head || typeof up.checkedAt !== 'string') return false;
  const age = now.getTime() - Date.parse(up.checkedAt);
  return age >= 0 && age < recheckMs;
}

// Keeps the keys it does not own; written through a temporary file in the same folder and a rename.
function saveState(dir, file, commit, now) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const state = { ...readState(file), up: { commit, checkedAt: now.toISOString() } };
  const tmp = join(dir, `.bridge.json.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// Runs the tasks with at most CONCURRENCY in flight. The first failure stops new tasks (those in
// flight finish) and is rethrown.
async function runTasks(tasks, signal) {
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (failure === null && next < tasks.length) {
      const task = tasks[next];
      next += 1;
      try {
        checkSignal(signal);
        await task();
      } catch (err) {
        failure ??= { err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
  if (failure) throw failure.err;
}

export async function runBridgeUp({
  config, s3, now = new Date(), recheckMs = 3_600_000, signal, deadline,
  scan = scanText, snapshotMaxBytes = SNAPSHOT_MAX_BYTES, // both only for tests
}) {
  const { repoDir } = config;
  const stateFile = join(config.stateDir, 'bridge.json');
  checkSignal(signal);
  const head = git(repoDir, ['rev-parse', 'HEAD']).stdout.trim();
  if (!COMMIT_RE.test(head)) throw new Error('git rev-parse HEAD returned an unexpected answer');
  const outcome = (status, extra = {}) => ({
    status, commit: head, full: false, puts: 0, deletes: 0, foreign: 0, snapshotBytes: 0, bodyLimit: 0, skipped: [], ...extra,
  });

  // 0. Only a commit that is also origin/main is sent: the caller's sync may have left local work.
  const tracked = git(repoDir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'], { allowFail: true });
  if (tracked.code !== 0 || tracked.stdout.trim() !== head) return outcome('not-synced');

  // 1. Believe the local state for a while.
  if (freshSince(readState(stateFile), head, now, recheckMs)) return outcome('unchanged');

  // 2. The record. One that already names head still gets a verification pass: another machine
  // may have written older content after it.
  checkSignal(signal);
  const got = await s3.get(RECORD_KEY, { deniedIsMissing: true });
  const etag = got.status === 'ok' ? got.etag : null;
  const recorded = got.status === 'ok' ? parseRecord(got.body) : null;
  const verify = recorded?.commit === head;

  // 3. The base: a recorded ancestor of head gives a delta; anything else a full upload.
  let base = null;
  if (recorded && !verify) {
    let rel = relation(repoDir, recorded.commit, head);
    let tip = null;
    if (rel === 'unknown') {
      tip = fetchTip(repoDir, signal, deadline);
      rel = relation(repoDir, recorded.commit, head);
    }
    if (rel === 'behind') return outcome('behind');
    if (rel === 'diverged') tip ??= fetchTip(repoDir, signal, deadline);
    if (tip !== null) {
      // After a fetch nothing is uploaded unless head is inside the remote's history. A record
      // inside it means this clone is the stale one; one outside it, with head inside, was
      // abandoned by a purge, and the full upload below replaces it.
      const inside = (sha) => sha === tip || isAncestor(repoDir, sha, tip);
      if (!inside(head) || (rel === 'diverged' && inside(recorded.commit))) return outcome('diverged');
    }
    if (rel === 'ahead') base = recorded.commit;
  }
  const full = base === null && !verify;

  // 4. Content from head: too large and flagged files are left out of everything.
  const sizes = memFiles(repoDir, head);
  const skipped = [];
  const readable = [];
  for (const [path, size] of [...sizes].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (size > MAX_FILE_BYTES) skipped.push({ path, reason: 'too-large' });
    else readable.push(path);
  }
  const contents = readBlobs(repoDir, head, readable);
  for (const path of readable) {
    if (scan(contents.get(path).toString('utf8')).length > 0) {
      skipped.push({ path, reason: 'flagged' });
      contents.delete(path);
    }
  }
  skipped.sort((x, y) => (x.path < y.path ? -1 : 1));
  // Built before the first write: a snapshot that cannot fit stops the run with nothing sent.
  const snapshot = fitSnapshot(head, contents, snapshotMaxBytes);

  // 5. What to put and delete under mem/.
  const toPut = [];
  const toDelete = new Set();
  let foreign = 0;
  if (base === null) {
    checkSignal(signal);
    const listed = await s3.list('mem/');
    const etags = new Map(listed.map((o) => [o.key, o.etag]));
    for (const [path, body] of contents) {
      if (etags.get(`mem/${path}`) !== md5Quoted(body)) toPut.push(path);
    }
    for (const { key } of listed) {
      const path = key.slice('mem/'.length);
      // A key that is not a mem path is invisible to the API and may not even be signable: left alone.
      if (!isMemPath(path)) foreign += 1;
      else if (!contents.has(path)) toDelete.add(path);
    }
  } else {
    const { changed, removed } = delta(repoDir, base, head);
    for (const path of changed) {
      if (contents.has(path)) toPut.push(path);
      else toDelete.add(path);
    }
    for (const path of removed) toDelete.add(path);
    for (const { path } of skipped) toDelete.add(path);
  }
  let puts = 0;
  let deletes = 0;
  const unconditional = (res, operation) => {
    if (res.status !== 'ok') throw new AwsError(operation, 409, 'Conflict');
  };
  const counts = () => ({ full, puts, deletes, foreign, snapshotBytes: snapshot.bytes, bodyLimit: snapshot.bodyLimit, skipped });

  // 6. Puts, then the snapshot, then deletes: the snapshot never lists a note whose object is gone.
  await runTasks(toPut.map((path) => async () => {
    unconditional(await s3.put(`mem/${path}`, contents.get(path), { contentType: NOTE_TYPE }), 'put');
    puts += 1;
  }), signal);
  checkSignal(signal);
  unconditional(await s3.put(SNAPSHOT_KEY, snapshot.json, { contentType: 'application/json' }), 'put');
  await runTasks([...toDelete].sort().map((path) => async () => {
    await s3.del(`mem/${path}`);
    deletes += 1;
  }), signal);

  // 7. The record stays as it is after a verification; otherwise it is written, but only if nobody
  // wrote it since it was read.
  if (verify) {
    saveState(config.stateDir, stateFile, head, now);
    return outcome(puts + deletes > 0 ? 'repaired' : 'verified', counts());
  }
  checkSignal(signal);
  const record = JSON.stringify({ version: 1, commit: head, host: config.host, time: now.toISOString() });
  const written = await s3.put(RECORD_KEY, record, {
    contentType: 'application/json', ...(etag === null ? { ifNoneMatch: '*' } : { ifMatch: etag }),
  });
  if (written.status !== 'ok') return outcome('raced', counts());

  // 8. Remember it (a completed upload counts as a verification).
  saveState(config.stateDir, stateFile, head, now);
  return outcome('uploaded', counts());
}
