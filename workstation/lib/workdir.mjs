// A private work folder for one consolidation run: copy the notes in, let a model edit the copy,
// judge the result with fixed rules, and write an accepted result back. Pure file-system logic;
// no Git, model or network. Only note files are ever copied or written, and a symbolic link is
// never followed.

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { INDEX, NOTE_NAME_RE, indexRefs, indexStats, stubTarget } from './notes.mjs';
import { scanText } from './secret-scan.mjs';

const MAX_NOTE_BYTES = 100000;
const SHRINK_MIN_BYTES = 20000;
const GLOBAL = 'global';
const HASH_RE = /^[0-9a-f]{64}$/;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isMissing = (err) => err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
const text = (buf) => buf.toString('utf8');
const isStub = (buf) => stubTarget(text(buf)) !== null;

// How a file is named in an error line: `<label>/<file>` for a valid note name. Any other name
// is quoted (it may hold a newline), and a name that looks like a credential is not shown.
function loc(label, name) {
  const s = String(name);
  if (!NOTE_NAME_RE.test(s)) return `${label}/${JSON.stringify(s.slice(0, 80))}`;
  if (scanText(s).length > 0) return `${label}/"(file name withheld)"`;
  return `${label}/${s}`;
}

// The bytes of a regular file, or null when the path is missing, is a symbolic link or is not a
// regular file. The open itself refuses a symbolic link, so a swap between check and read is safe.
function readRegular(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if (isMissing(err) || err.code === 'ELOOP') return null;
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

// Entries of a folder: the regular note files (name to bytes) and the names of everything else,
// including a note file that cannot be read. With `strict`, a read error is thrown instead.
function scanDir(dir, { strict = false } = {}) {
  const files = new Map();
  const other = [];
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (isMissing(err)) return { files, other };
    throw err;
  }
  for (const name of names.sort()) {
    let buf = null;
    if (NOTE_NAME_RE.test(name)) {
      try {
        buf = readRegular(join(dir, name));
      } catch (err) {
        if (strict) throw err;
      }
    }
    if (buf) files.set(name, buf);
    else other.push(name);
  }
  return { files, other };
}

export function snapshot(pairs) {
  // Check and read everything first, so that a folder that cannot be used leaves nothing behind.
  const staged = pairs.map(({ label, liveDir, workDir }) => {
    let st = null;
    try {
      st = lstatSync(workDir);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    if (st && (!st.isDirectory() || readdirSync(workDir).length > 0)) {
      throw new Error(`${label}: work folder is not an empty folder`);
    }
    return { label, workDir, files: scanDir(liveDir, { strict: true }).files };
  });
  const result = {};
  for (const { label, workDir, files } of staged) {
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    chmodSync(workDir, 0o700);
    result[label] = {};
    for (const [name, buf] of files) {
      writeFileSync(join(workDir, name), buf, { mode: 0o600, flag: 'wx' });
      result[label][name] = sha256(buf);
    }
  }
  return result;
}

// Number of non-stub notes (other than the index) that the index does not link to.
function unlisted(files) {
  const index = files.get(INDEX);
  const refs = indexRefs(index ? text(index) : '');
  let n = 0;
  for (const [name, buf] of files) {
    if (name !== INDEX && !isStub(buf) && !refs.has(name)) n += 1;
  }
  return n;
}

// Total bytes of the notes other than the index; with `skipStubs`, retired notes do not count.
function notesBytes(files, { skipStubs = false } = {}) {
  let n = 0;
  for (const [name, buf] of files) {
    if (name !== INDEX && !(skipStubs && isStub(buf))) n += buf.length;
  }
  return n;
}

export function liveDiffers(pairs, snap) {
  const diff = [];
  for (const { label, liveDir } of pairs) {
    const known = snap[label] ?? {};
    const live = scanDir(liveDir).files;
    for (const [name, buf] of live) {
      if (known[name] !== sha256(buf)) diff.push(`${label}/${name}`);
    }
    for (const name of Object.keys(known)) {
      if (!live.has(name)) diff.push(`${label}/${name}`);
    }
  }
  return diff;
}

// Why a changed or new, non-stub file is not acceptable; null when it is.
function contentProblem(name, buf) {
  const body = text(buf);
  const trimmed = body.trim();
  if (trimmed.startsWith('MOVED TO [[')) return 'malformed retirement line';
  if (name !== INDEX && trimmed === '') return 'a note may not be emptied; retire it instead';
  if (buf.length > MAX_NOTE_BYTES) return `note is larger than ${MAX_NOTE_BYTES} bytes`;
  if (scanText(body).length > 0) return 'note contains text that looks like a credential';
  if (scanText(name).length > 0) return 'file name looks like a credential';
  return null;
}

// Judges the work folders against the snapshot. "Before" is the live folder, which the snapshot
// was taken from (`liveChanged` reports when it no longer is); "after" is the live folder with
// the accepted changes applied. `maxShrink` is the share of a folder's note bytes that must
// remain (0 turns the check off).
export function evaluate({ pairs, snap, allowRetire, maxShrink = 0.5 }) {
  const errors = [];
  const changes = [];
  const ignored = [];
  const stats = {};
  const work = {};
  for (const { label, workDir } of pairs) {
    const { files, other } = scanDir(workDir);
    work[label] = files;
    for (const name of other) errors.push(`${loc(label, name)}: not a regular note file`);
  }

  for (const { label } of pairs) {
    const known = snap[label] ?? {};
    for (const [name, buf] of work[label]) {
      const hash = sha256(buf);
      if (known[name] === hash) continue;
      const where = loc(label, name);
      const isNew = !Object.hasOwn(known, name);
      const stub = stubTarget(text(buf));
      if (stub) {
        if (isNew) {
          ignored.push(where);
          continue;
        }
        if (name === INDEX) {
          errors.push(`${where}: the index may not be retired`);
          continue;
        }
        if (!allowRetire) {
          ignored.push(where);
          continue;
        }
        const targetLabel = stub.folder === 'global' ? GLOBAL : label;
        const targetFile = `${stub.name}.md`;
        const targetBuf = work[targetLabel]?.get(targetFile);
        let problem = null;
        if (stub.folder === 'global' && label === GLOBAL) problem = 'a global note cannot move to global';
        else if (!work[targetLabel]) problem = 'the target folder is not available';
        else if (targetFile === INDEX) problem = 'the target is the index';
        else if (targetLabel === label && targetFile === name) problem = 'the note names itself as target';
        else if (!targetBuf) problem = 'the target note does not exist';
        else if (isStub(targetBuf)) problem = 'the target note is itself retired';
        if (problem) {
          errors.push(`${where}: ${problem}`);
        } else {
          changes.push({ label, file: name, kind: 'retire', hash: known[name], target: { label: targetLabel, file: targetFile } });
        }
        continue;
      }
      const problem = contentProblem(name, buf);
      if (problem) errors.push(`${where}: ${problem}`);
      else changes.push({ label, file: name, kind: isNew ? 'add' : 'change', hash });
    }
  }

  for (const { label, liveDir } of pairs) {
    const before = scanDir(liveDir).files;
    const after = new Map(before);
    let retiredBytes = 0;
    for (const c of changes) {
      if (c.label !== label) continue;
      if (c.kind === 'retire') {
        retiredBytes += before.get(c.file)?.length ?? 0;
        after.delete(c.file);
      } else {
        after.set(c.file, work[label].get(c.file));
      }
    }
    const notesBytesBefore = notesBytes(before);
    const notesBytesAfter = notesBytes(after, { skipStubs: true });
    stats[label] = {
      indexBefore: indexStats(before.has(INDEX) ? text(before.get(INDEX)) : ''),
      indexAfter: indexStats(after.has(INDEX) ? text(after.get(INDEX)) : ''),
      unlistedBefore: unlisted(before),
      unlistedAfter: unlisted(after),
      notesBytesBefore,
      notesBytesAfter,
      retiredBytes,
    };
    if (stats[label].unlistedAfter > stats[label].unlistedBefore) {
      errors.push(`${label}/${INDEX}: more notes without an index line than before`);
    }
    const indexChanged = changes.some((c) => c.label === label && c.file === INDEX && c.kind !== 'retire');
    const index = after.get(INDEX);
    if (indexChanged && text(index).trim() === '' && [...after].some(([n, b]) => n !== INDEX && !isStub(b))) {
      errors.push(`${label}/${INDEX}: the index may not be emptied while notes remain`);
    }
    if (maxShrink > 0 && notesBytesBefore >= SHRINK_MIN_BYTES && notesBytesAfter < notesBytesBefore * maxShrink) {
      errors.push(`${label}/${INDEX}: the folder's notes shrank by more than the allowed share`);
    }
  }
  const liveChanged = liveDiffers(pairs, snap);
  return { ok: errors.length === 0 && liveChanged.length === 0, errors, changes, ignored, stats, liveChanged };
}

function writeAtomic(dir, name, buf) {
  const dest = join(dir, name);
  const tmp = join(dir, `${name}.tmp.${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, buf, { mode: 0o644, flag: 'wx' });
    renameSync(tmp, dest);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* temporary file may not exist */ }
    throw err;
  }
}

// Writes an accepted result into the live folders. Everything is verified before the first
// write: the work files still hold the validated bytes, and the live files about to be replaced
// or deleted still hold what the snapshot copied (a file added by a change must not exist live).
// Any mismatch throws, naming the file and the check, and nothing is written or deleted. The
// bytes written are the bytes that were verified.
export function apply({ pairs, changes, snap }) {
  if (!snap || typeof snap !== 'object') throw new Error('apply needs the snapshot');
  const byLabel = new Map(pairs.map((p) => [p.label, p]));
  const fail = (label, file, why) => { throw new Error(`${loc(label, file)}: ${why}`); };
  const pairOf = (label, file) => {
    const pair = byLabel.get(label);
    if (!pair) fail(label, file, 'unknown folder');
    return pair;
  };
  const liveHash = (pair, file) => {
    const buf = readRegular(join(pair.liveDir, file));
    return buf ? sha256(buf) : null;
  };
  const seen = new Set();
  const writes = [];
  const retires = [];
  for (const c of changes) {
    const pair = pairOf(c.label, c.file);
    if (!NOTE_NAME_RE.test(c.file)) fail(c.label, c.file, 'not a note file name');
    if (!HASH_RE.test(c.hash ?? '')) fail(c.label, c.file, 'change has no validated hash');
    const key = `${c.label}/${c.file}`;
    if (seen.has(key)) fail(c.label, c.file, 'listed twice');
    seen.add(key);
    let st = null;
    try {
      st = statSync(pair.liveDir);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    if (st && !st.isDirectory()) fail(c.label, c.file, 'the live folder is not a folder');
    const known = snap[c.label]?.[c.file];
    if (c.kind === 'add') {
      if (known !== undefined) fail(c.label, c.file, 'added file is already in the snapshot');
      let exists = true;
      try {
        lstatSync(join(pair.liveDir, c.file));
      } catch (err) {
        if (!isMissing(err)) throw err;
        exists = false;
      }
      if (exists) fail(c.label, c.file, 'a live file appeared since the snapshot');
    } else if (c.kind === 'change' || c.kind === 'retire') {
      if (known === undefined) fail(c.label, c.file, 'file is not in the snapshot');
      if (liveHash(pair, c.file) !== known) fail(c.label, c.file, 'live file changed since the snapshot');
    } else {
      fail(c.label, c.file, 'unknown change kind');
    }
    const buf = readRegular(join(pair.workDir, c.file));
    if (!buf) fail(c.label, c.file, 'work file is not a regular file');
    if (c.kind === 'retire') {
      if (c.hash !== known) fail(c.label, c.file, 'retirement hash does not match the snapshot');
      if (c.file === INDEX || !isStub(buf)) fail(c.label, c.file, 'work file is not a retirement stub');
      retires.push(c);
    } else {
      if (sha256(buf) !== c.hash) fail(c.label, c.file, 'work file changed since it was validated');
      writes.push({ pair, file: c.file, buf });
    }
  }
  // A retirement needs its target: written by this change set, or present live, and not retired.
  for (const c of retires) {
    const t = c.target;
    if (!t || !NOTE_NAME_RE.test(t.file) || t.file === INDEX || (t.label === c.label && t.file === c.file)) {
      fail(c.label, c.file, 'invalid retirement target');
    }
    const targetPair = pairOf(t.label, t.file);
    if (retires.some((r) => r.label === t.label && r.file === t.file)) fail(c.label, c.file, 'the target is itself retired');
    const present = writes.some((w) => w.pair === targetPair && w.file === t.file) ||
      readRegular(join(targetPair.liveDir, t.file)) !== null;
    if (!present) fail(c.label, c.file, 'retirement target is not present');
  }
  // Indexes last, so that a failure part-way leaves an index that lists only notes that exist.
  writes.sort((a, b) => (a.file === INDEX) - (b.file === INDEX));
  for (const { pair, file, buf } of writes) {
    mkdirSync(pair.liveDir, { recursive: true });
    writeAtomic(pair.liveDir, file, buf);
  }
  for (const c of retires) {
    try {
      unlinkSync(join(pairOf(c.label, c.file).liveDir, c.file));
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
}
