import { randomBytes } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { dirname, join, parse } from 'node:path';

const INDEX = 'MEMORY.md';
const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 50;
const DEFAULT_LOCK_WAIT_MS = 10_000;

function lines(text) {
  const parts = text.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

export function mergeIndex(targetText, incomingText, renames) {
  const out = lines(targetText);
  const seen = new Set(out.map((l) => l.trimEnd()));
  for (let line of lines(incomingText)) {
    line = line.replace(/\]\(([^)]+)\)/g, (m, p) => (renames.has(p) ? `](${renames.get(p)})` : m));
    const key = line.trimEnd();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

function readIfFile(path) {
  try {
    return readFileSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// A name beside `path` that the notes repository ignores (`*.tmp.*`).
const tempPath = (path) => `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;

// Writes `to` through a temporary name in the same directory and renames it into place, so
// an interrupted write never leaves a truncated file under the real name.
function writeInPlace(to, write) {
  const tmp = tempPath(to);
  try {
    write(tmp);
    renameSync(tmp, to);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// Returns false when `from` was deleted meanwhile (a session removing a note while we copy).
function copyKeepingTime(from, to) {
  try {
    writeInPlace(to, (tmp) => {
      copyFileSync(from, tmp);
      const st = statSync(from);
      utimesSync(tmp, st.atime, st.mtime);
    });
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' && lstatOrNull(from) === null) return false;
    throw err;
  }
}

const GONE = new Set(['ENOENT', 'ENOTDIR']);

// True when dir holds anything other than regular files (a subfolder, a symlink).
export function hasNestedEntries(dir) {
  return readdirSync(dir, { withFileTypes: true }).some((e) => !e.isFile());
}

// Copies regular files that sit directly in srcDir into targetDir.
export function adoptDir(srcDir, targetDir, host, opts = {}) {
  const skip = opts.skip ?? new Set();
  mkdirSync(targetDir, { recursive: true });
  const names = readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isFile() && !skip.has(e.name))
    .map((e) => e.name)
    .sort();
  const renames = new Map();
  const renamed = [];
  let copied = 0;

  for (const name of names.filter((n) => n !== INDEX)) {
    const from = join(srcDir, name);
    const bytes = readIfFile(from);
    if (bytes === null) continue; // deleted since the listing
    const existing = readIfFile(join(targetDir, name));
    if (existing === null) {
      if (copyKeepingTime(from, join(targetDir, name))) copied += 1;
      continue;
    }
    if (existing.equals(bytes)) continue;

    const { name: stem, ext } = parse(name);
    let used = null;
    for (let n = 1; used === null; n += 1) {
      const candidate = `${stem}.${host}${n === 1 ? '' : `-${n}`}${ext}`;
      if (names.includes(candidate)) continue; // a source file still to be processed owns this name
      const other = readIfFile(join(targetDir, candidate));
      if (other === null) {
        if (!copyKeepingTime(from, join(targetDir, candidate))) break;
        copied += 1;
        renamed.push(`${name} -> ${candidate}`);
        used = candidate;
      } else if (other.equals(bytes)) {
        used = candidate;
      }
    }
    if (used !== null) renames.set(name, used);
  }

  if (names.includes(INDEX)) {
    const incomingBytes = readIfFile(join(srcDir, INDEX));
    if (incomingBytes !== null) {
      const current = readIfFile(join(targetDir, INDEX));
      const merged = mergeIndex(current === null ? '' : current.toString('utf8'), incomingBytes.toString('utf8'), renames);
      if (current === null || merged !== current.toString('utf8')) {
        writeInPlace(join(targetDir, INDEX), (tmp) => writeFileSync(tmp, merged));
      }
    }
  }
  return { copied, renamed };
}

function stamp(now) {
  return now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function makeLock(lockPath) {
  try {
    mkdirSync(lockPath);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

// Takes the lock directory; returns false when someone else holds it. A stale lock is
// claimed by renaming it to a unique name first: only the process whose rename succeeds
// removes it and tries to take the lock.
function takeLock(lockPath) {
  if (makeLock(lockPath)) return true;
  const st = lstatOrNull(lockPath);
  if (!st || Date.now() - st.mtimeMs <= LOCK_STALE_MS) return false;
  const claimed = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    renameSync(lockPath, claimed);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  rmSync(claimed, { recursive: true, force: true });
  return makeLock(lockPath);
}

// True when linkPath is a symbolic link that resolves to dir.
function linksTo(linkPath, dir) {
  try {
    return lstatSync(linkPath).isSymbolicLink() && realpathSync(linkPath) === realpathSync(dir);
  } catch {
    return false;
  }
}

function result(action, extra = {}) {
  return { action, copied: 0, renamed: [], backupDir: null, reason: null, ...extra };
}

function freeBackupName(linkPath, now) {
  const base = `${linkPath}.local-backup-${stamp(now)}`;
  let candidate = base;
  for (let n = 2; existsSync(candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

// Adopts the real directory at linkPath under the lock. Returns null when the
// state changed under us and the caller should look again.
function adoptUnderLock({ linkPath, targetDir, host, now, skip }, steps) {
  steps.afterLock?.();
  if (!lstatOrNull(linkPath)?.isDirectory()) return null;
  // The folder can still vanish or change type here (a session removing it); then look again.
  let first;
  try {
    if (hasNestedEntries(linkPath)) return result('skipped', { reason: 'nested-entries' });
    first = adoptDir(linkPath, targetDir, host, { skip });
  } catch (err) {
    if (GONE.has(err.code) && !lstatOrNull(linkPath)?.isDirectory()) return null;
    throw err;
  }
  const backupDir = freeBackupName(linkPath, now);
  if (!lstatOrNull(linkPath)?.isDirectory()) return null;
  try {
    renameSync(linkPath, backupDir);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  // A note written between the first pass and the rename is in the backup now.
  let second;
  try {
    second = adoptDir(backupDir, targetDir, host, { skip });
  } catch (err) {
    // A non-directory took the path just before our rename and was moved aside with it.
    if (!GONE.has(err.code) || lstatOrNull(backupDir)?.isDirectory()) throw err;
    return null; // look again: the path is free now
  }
  const copied = first.copied + second.copied;
  const renamed = [...first.renamed, ...second.renamed];
  try {
    symlinkSync(targetDir, linkPath);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (!linksTo(linkPath, targetDir)) return result('skipped', { reason: 'link-path-taken', copied, renamed, backupDir });
  }
  return result('adopted', { copied, renamed, backupDir });
}

export function ensureLink({ linkPath, targetDir, host, now = new Date(), lockWaitMs = DEFAULT_LOCK_WAIT_MS, skip }, steps = {}) {
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(dirname(linkPath), { recursive: true });
  const lockPath = `${linkPath}.adopt-lock`;
  const deadline = Date.now() + lockWaitMs;

  while (Date.now() < deadline) {
    const st = lstatOrNull(linkPath);
    if (st === null) {
      try {
        symlinkSync(targetDir, linkPath);
        return result('linked');
      } catch (err) {
        if (err.code === 'EEXIST') continue;
        throw err;
      }
    }
    if (st.isSymbolicLink()) {
      let resolved = null;
      try {
        resolved = realpathSync(linkPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      return resolved !== null && resolved === realpathSync(targetDir)
        ? result('ok')
        : result('skipped', { reason: 'foreign-symlink' });
    }
    if (!st.isDirectory()) return result('skipped', { reason: 'not-a-directory' });
    steps.beforeNestedCheck?.();
    try {
      if (hasNestedEntries(linkPath)) return result('skipped', { reason: 'nested-entries' });
    } catch (err) {
      if (GONE.has(err.code)) continue; // another process changed the path; look at it again
      throw err;
    }

    if (!takeLock(lockPath)) {
      sleep(LOCK_POLL_MS);
      continue;
    }
    try {
      const adopted = adoptUnderLock({ linkPath, targetDir, host, now, skip }, steps);
      if (adopted) return adopted;
    } finally {
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
  return result('skipped', { reason: 'lock-timeout' });
}
