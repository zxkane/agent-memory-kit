// Bridge down: copies what agents wrote under `agents/` in the bucket into the folder `agents/` of a
// second Git clone (the agents repository), commits it and sends it to that repository's remote.
//
// What holds, whatever the bucket or the remote of the second clone contain:
// - Everything under `agents/` in the bucket is untrusted: a key is used only after it matches the
//   two API rules, the path to write is built from the two matched parts, and the bytes are written
//   as received, never interpreted.
// - Before anything is fetched, reset, cleaned or written, the real paths of the two clones are
//   compared (they must not overlap), the origin URLs are compared in canonical form, and after the
//   fetch the remote branch must carry the marker file `.agent-memory-mirror`; otherwise the run
//   throws and changes nothing in either clone. The only Git command run in the notes clone is
//   `remote get-url origin`; nothing is ever written there.
// - The bridge's own writes, removals and staging are confined to `<clone>/agents/`, which belongs
//   to it: whatever the remote or a local file puts there (files, other folders, links, gitlinks,
//   ignored files) is removed or replaced. The fetch, reset and whole-clone clean bring the rest of
//   the clone to the remote's state, discarding local changes and local commits, and the clone-local
//   attributes file is overwritten; the owner's tracked files outside `agents/` stay as the remote has them.
// - Each run compares the listed ETag of every entry with the MD5 of the file on disk, so a change
//   made on the remote is repaired; no state is kept between runs. What is staged (forced, so a
//   `.gitignore` cannot hide files) must be exactly the kept files at mode 100644, or the run throws.
//   `agents` itself being a link, a file or a gitlink throws.

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { AwsError } from './aws.mjs';
import { TIMEOUT_CODE, git } from './git.mjs';
import { scanText } from './secret-scan.mjs';
import { removeStaleLocks } from './sync-engine.mjs';
import { identity } from './sync-engine.mjs';

// The API's path rules (api/src/validate.ts), copied character for character; a test compares them.
export const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,196}\.md$/;

const inner = (re) => re.source.slice(1, -1);
// `agents/<agent>/<file>`, anchored; the matched parts are the only text a path is built from.
const ENTRY_RE = new RegExp(`^agents/(${inner(AGENT_RE)})/(${inner(FILE_RE)})$`);

const BRANCH = 'main';
const MARKER = '.agent-memory-mirror';
const MIRROR = 'agents';
const MAX_BYTES = 200_000;
const MAX_ENTRIES = 5_000;
const CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 20_000;
const PUSH_TIMEOUT_MS = 30_000;
const MAX_REPORTED = 200;
const MAX_KEY_CHARS = 200;
const ATTRIBUTES = '* -text -eol -ident -filter -working-tree-encoding\n';

// An error whose message is fixed text: it never holds a key, a path, a URL or Git output.
export class BridgeDownError extends Error {}

const unusable = (reason) => new BridgeDownError(`the agents clone is not usable: ${reason}`);
const FOLDER_PROBLEM = 'the agents clone has a link or a file where an agent folder belongs';

function checkSignal(signal) {
  if (signal?.aborted) throw new AwsError('bridge-down', 0, 'TimeLimit');
}

const MIN_NETWORK_MS = 2_000;

// The time limit of a blocking Git network command: its own `limitMs`, cut to what is left before
// the caller's `deadline` (epoch milliseconds). With less than MIN_NETWORK_MS left the command is
// not started and the step ends with the time-limit error. Without a deadline, or with one that is not
// a finite number: `limitMs`.
export function networkLimit(limitMs, deadline) {
  if (!Number.isFinite(deadline)) return limitMs;
  const left = deadline - Date.now();
  if (left < MIN_NETWORK_MS) throw new AwsError('bridge-down', 0, 'TimeLimit');
  return Math.min(limitMs, left);
}

// A key is caller-controlled text: cut to 200 characters, control, format and surrogate characters replaced.
const reportable = (key) => [...key].slice(0, MAX_KEY_CHARS).join('').replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, '?');

// A remote URL reduced to host/path: no scheme, user information or port; scp-like `host:path`
// turned into `host/path`; host lower-cased; no trailing `/` or `.git`. Never shown anywhere.
function canonicalRemote(raw) {
  let url = String(raw).trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i;
  if (scheme.test(url)) {
    url = url.replace(scheme, '');
  } else {
    const scp = /^(?:[^/@:]+@)?([^/:@]{2,}):(.*)$/.exec(url);
    if (scp) url = `${scp[1]}/${scp[2]}`;
  }
  const slash = url.indexOf('/');
  const authority = slash < 0 ? url : url.slice(0, slash);
  const rest = slash < 0 ? '' : url.slice(slash);
  const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '').toLowerCase();
  return `${host}${rest}`.replace(/\/+$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
}

export const sameRemote = (a, b) => canonicalRemote(a) === canonicalRemote(b);

// null when nothing is there, also when a part of the path is a file (ENOTDIR).
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
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

// The real, resolved top level of the agents clone, or a reason it cannot be used. Nothing is changed.
function checkClone(config) {
  let root;
  try {
    root = realpathSync(config.bridge.agentsRepoDir);
  } catch {
    throw unusable('the folder does not exist');
  }
  const top = git(root, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (top.code !== 0) throw unusable('not a Git work tree');
  let topReal;
  try {
    topReal = realpathSync(top.stdout.trim());
  } catch {
    throw unusable('not a Git work tree');
  }
  if (topReal !== root) throw unusable('not the top level of a Git work tree');

  // Real paths, not text: a link must not hide one clone inside the other.
  let notes;
  try {
    notes = realpathSync(config.repoDir);
  } catch {
    throw unusable('the notes clone cannot be resolved');
  }
  const [a, n] = [`${root}${sep}`, `${notes}${sep}`];
  if (a.startsWith(n) || n.startsWith(a)) throw unusable('it overlaps the notes clone');

  if (!lstatOrNull(join(root, '.git'))?.isDirectory()) throw unusable('no .git folder');
  const branch = git(root, ['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true }).stdout.trim();
  if (branch !== BRANCH) throw unusable(`not on ${BRANCH}`);
  const url = git(root, ['remote', 'get-url', 'origin'], { allowFail: true });
  if (url.code !== 0 || url.stdout.trim() === '') throw unusable('no origin');
  // The only Git command that touches the notes clone; it changes nothing.
  const notesUrl = git(config.repoDir, ['remote', 'get-url', 'origin'], { allowFail: true });
  if (notesUrl.code !== 0 || notesUrl.stdout.trim() === '') throw unusable('the notes clone has no readable remote');
  if (sameRemote(notesUrl.stdout, url.stdout)) throw unusable('the two clones have the same remote');
  return root;
}

const STALE_LOCKS = ['index.lock', 'HEAD.lock', `refs/heads/${BRANCH}.lock`, `refs/remotes/origin/${BRANCH}.lock`];

// Makes the mirror of origin/main: fetch, check the marker, hard reset, clean (never -x).
// Attributes from the remote (line-ending conversion, filters) must not change the bytes, so the
// clone's own attributes file switches them off and takes precedence over the committed ones.
function resetClone(root, signal, deadline) {
  checkSignal(signal);
  // A run that was killed leaves its Git locks behind and every later run would fail on them.
  removeStaleLocks(root, STALE_LOCKS);
  const fetchLimit = networkLimit(FETCH_TIMEOUT_MS, deadline);
  const fetch = git(root, ['fetch', '-q', '--no-auto-maintenance', '--no-tags', '--no-recurse-submodules', 'origin',
    `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`], { allowFail: true, timeoutMs: fetchLimit });
  if (fetch.code === TIMEOUT_CODE && fetchLimit < FETCH_TIMEOUT_MS) throw new AwsError('bridge-down', 0, 'TimeLimit');
  if (fetch.code !== 0) throw new BridgeDownError('fetching the agents repository failed');
  // Only remote-tracking refs have changed so far. The remote must say it is the agents repository.
  const marker = git(root, ['ls-tree', `refs/remotes/origin/${BRANCH}`, '--', MARKER], { allowFail: true });
  const fields = /^(\d+) (\w+) [0-9a-f]+\t/.exec(marker.stdout);
  if (marker.code !== 0 || !fields || fields[2] !== 'blob' || !['100644', '100755'].includes(fields[1])) {
    throw unusable(`its remote has no ${MARKER} marker`);
  }
  mkdirSync(join(root, '.git', 'info'), { recursive: true });
  writeFileSync(join(root, '.git', 'info', 'attributes'), ATTRIBUTES);
  git(root, ['reset', '-q', '--hard', `refs/remotes/origin/${BRANCH}`]);
  // -ff also removes untracked folders that hold a repository of their own.
  git(root, ['clean', '-ffdq']);
  // agents/ belongs to the bridge: also ignored files go (the only place where -x is used).
  git(root, ['clean', '-ffdxq', '--', MIRROR]);
  // `agents` itself must be a plain folder of the remote, not a link or a gitlink (those are not repairable).
  const own = git(root, ['ls-files', '-s', '-z', '--', MIRROR]).stdout.split('\0').some((e) => e.endsWith(`\t${MIRROR}`));
  if (own) throw unusable('agents is not a folder in its remote');
}

const headOf = (root) => git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }).stdout.trim();

// `dir` must be a real directory when it exists (a link or a file throws); created when `create`.
// Returns whether it exists afterwards.
function checkDir(dir, create) {
  const st = lstatOrNull(dir);
  if (st === null) {
    if (!create) return false;
    mkdirSync(dir, { mode: 0o755 });
    return true;
  }
  if (!st.isDirectory()) throw new BridgeDownError(FOLDER_PROBLEM);
  return true;
}

const md5Quoted = (body) => `"${createHash('md5').update(body).digest('hex')}"`;

// Whether the file is a regular, non-executable file of a size we would write whose ETag form is `etag`.
function matches(path, etag) {
  const st = lstatOrNull(path);
  if (st === null || !st.isFile() || st.size > MAX_BYTES || (st.mode & 0o111) !== 0) return false;
  return md5Quoted(readFileSync(path)) === etag;
}

// Writes `body` as `<mirror>/<agent>/<file>` through a temporary name in the same folder and a
// rename: a link at the destination is replaced, not followed. Returns whether bytes were written.
function writeEntry(mirror, agent, file, body) {
  const dir = resolve(mirror, agent);
  const dest = resolve(dir, file);
  if (!dest.startsWith(`${mirror}${sep}`) || !dir.startsWith(`${mirror}${sep}`) || resolve(dest, '..') !== dir) {
    throw new BridgeDownError('a path left the agents clone');
  }
  if (!lstatOrNull(dir)?.isDirectory()) throw new BridgeDownError(FOLDER_PROBLEM);
  const st = lstatOrNull(dest);
  if (st?.isFile() && (st.mode & 0o111) === 0 && st.size === body.length && readFileSync(dest).equals(body)) return false;
  if (st?.isDirectory()) rmSync(dest, { recursive: true, force: true });
  const tmp = join(dir, `.${randomBytes(8).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, body, { flag: 'wx', mode: 0o644 });
    chmodSync(tmp, 0o644);
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return true;
}

// Everything directly under the mirror that is not a real folder with an agent name is removed, and
// inside agent folders everything that is not a kept file (links are removed, never followed); then
// agent folders left empty. Returns the number of entries removed.
function sweep(mirror, keep) {
  let removed = 0;
  for (const name of readdirSync(mirror)) {
    const dir = join(mirror, name);
    if (!AGENT_RE.test(name) || !lstatOrNull(dir)?.isDirectory()) {
      rmSync(dir, { recursive: true, force: true });
      removed += 1;
      continue;
    }
    for (const entry of readdirSync(dir)) {
      if (keep.has(`${name}/${entry}`) && lstatOrNull(join(dir, entry))?.isFile()) continue;
      rmSync(join(dir, entry), { recursive: true, force: true });
      removed += 1;
    }
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  }
  return removed;
}

// The index entries under agents/ must be exactly the kept files, each a regular file of mode 100644.
function indexMatches(root, keep) {
  const out = git(root, ['ls-files', '-s', '-z', '--', MIRROR]).stdout;
  const seen = new Set();
  for (const entry of out.split('\0').filter(Boolean)) {
    const m = /^(\d+) [0-9a-f]+ (\d+)\t(.*)$/s.exec(entry);
    if (!m || m[1] !== '100644' || m[2] !== '0') return false;
    seen.add(m[3]);
  }
  const want = new Set([...keep].map((k) => `${MIRROR}/${k}`));
  return seen.size === want.size && [...seen].every((p) => want.has(p));
}

export async function runBridgeDown({ config, s3, signal, deadline }) {
  let stage = 'check';
  try {
    checkSignal(signal);
    const { down } = config.bridge;
    if (down && !s3) throw new BridgeDownError('no S3 client');
    const root = checkClone(config);
    const before = headOf(root);

    stage = 'update';
    resetClone(root, signal, deadline);

    // `{ status, written, removed, skipped, commit }`; `skipped` is `[{ key, reason }]` (at most 200,
    // keys cut and cleaned) and `skippedMore` is added, as the number left out, only when some were.
    if (!down) {
      const head = headOf(root);
      return { status: head !== before ? 'pulled' : 'unchanged', written: 0, removed: 0, skipped: [], commit: head };
    }

    stage = 'list';
    checkSignal(signal);
    const listed = await s3.list(`${MIRROR}/`);
    const skipped = [];
    const valid = [];
    for (const { key, etag, size } of listed) {
      const m = ENTRY_RE.exec(key);
      if (!m) skipped.push({ key, reason: 'bad-key' });
      else valid.push({ key, agent: m[1], file: m[2], etag, size });
    }
    if (valid.length > MAX_ENTRIES) throw new BridgeDownError('too many agent notes in the bucket');

    stage = 'download';
    const mirror = join(root, MIRROR);
    const mirrorExists = checkDir(mirror, false);
    // Every listed agent's folder is checked on every run, not only when something is written.
    if (mirrorExists) for (const agent of new Set(valid.map((e) => e.agent))) checkDir(join(mirror, agent), false);

    const keep = new Set();
    const toGet = [];
    for (const entry of valid) {
      if (entry.size > MAX_BYTES) {
        skipped.push({ key: entry.key, reason: 'too-large' });
      } else if (mirrorExists && matches(join(mirror, entry.agent, entry.file), entry.etag)) {
        keep.add(`${entry.agent}/${entry.file}`);
      } else {
        toGet.push(entry);
      }
    }
    if (toGet.length > 0) {
      checkDir(mirror, true);
      for (const agent of new Set(toGet.map((e) => e.agent))) checkDir(join(mirror, agent), true);
    }

    let written = 0;
    checkSignal(signal);
    await runTasks(toGet.map((entry) => async () => {
      let got;
      try {
        got = await s3.get(entry.key, { maxBytes: MAX_BYTES });
      } catch (err) {
        if (err instanceof AwsError && err.code === 'TooLarge') {
          skipped.push({ key: entry.key, reason: 'too-large' });
          return;
        }
        throw err;
      }
      if (got.status !== 'ok') return; // gone since the listing
      if (scanText(got.body.toString('utf8')).length > 0) {
        skipped.push({ key: entry.key, reason: 'flagged' });
        return;
      }
      if (writeEntry(mirror, entry.agent, entry.file, got.body)) written += 1;
      keep.add(`${entry.agent}/${entry.file}`);
    }), signal);

    stage = 'clean';
    const removed = checkDir(mirror, false) ? sweep(mirror, keep) : 0;

    stage = 'commit';
    // What is on disk replaces whatever the index holds under agents/ (gitlinks, other modes, extra paths).
    git(root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', MIRROR]);
    if (lstatOrNull(mirror) !== null) git(root, ['add', '-A', '-f', '--', MIRROR]);
    if (!indexMatches(root, keep)) {
      git(root, ['reset', '-q'], { allowFail: true });
      throw unusable('its index does not match the mirror');
    }
    const staged = git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--', MIRROR]).stdout.split('\0').filter(Boolean).length;
    let committed = false;
    if (staged > 0) {
      git(root, [...identity(config.host), 'commit', '-q', '-m', `bridge(${config.host}): ${staged} file(s)`]);
      committed = true;
    }
    const commit = headOf(root);

    const reported = skipped.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)).slice(0, MAX_REPORTED)
      .map(({ key, reason }) => ({ key: reportable(key), reason }));
    const extra = skipped.length > MAX_REPORTED ? { skippedMore: skipped.length - MAX_REPORTED } : {};

    if (committed) {
      stage = 'push';
      checkSignal(signal);
      const pushLimit = networkLimit(PUSH_TIMEOUT_MS, deadline);
      const push = git(root, ['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`], { allowFail: true, timeoutMs: pushLimit });
      if (push.code === TIMEOUT_CODE && pushLimit < PUSH_TIMEOUT_MS) throw new AwsError('bridge-down', 0, 'TimeLimit');
      if (push.code !== 0) return { status: 'push-failed', written, removed, skipped: reported, commit, ...extra };
    }
    return { status: committed ? 'mirrored' : 'unchanged', written, removed, skipped: reported, commit, ...extra };
  } catch (err) {
    if (err instanceof AwsError || err instanceof BridgeDownError) throw err;
    // Anything else (Git output, file system errors) can hold a path or a key: only the stage is reported.
    throw new BridgeDownError(`bridge down failed while trying to ${stage}`);
  }
}
