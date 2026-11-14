// A private work folder for one consolidation run: copy the notes in, let a model edit the copy,
// judge the result with fixed rules, and write an accepted result back. Pure file-system logic;
// no Git, model or network. Only note files are ever copied or written, and a symbolic link is
// never followed.

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { INDEX, NOTE_NAME_RE, indexRefs, indexStats, stubTarget } from './notes.mjs';
import { scanText } from './secret-scan.mjs';

const MAX_NOTE_BYTES = 100000;
const GLOBAL = 'global';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isMissing = (err) => err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');

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

// Entries of a folder: the regular note files (name to bytes) and the names of everything else.
function scanDir(dir) {
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
    const buf = NOTE_NAME_RE.test(name) ? readRegular(join(dir, name)) : null;
    if (buf) files.set(name, buf);
    else other.push(name);
  }
  return { files, other };
}

export function snapshot(pairs) {
  const result = {};
  for (const { label, liveDir, workDir } of pairs) {
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    chmodSync(workDir, 0o700);
    if (readdirSync(workDir).length > 0) throw new Error(`${label}: work folder is not empty`);
    result[label] = {};
    for (const [name, buf] of scanDir(liveDir).files) {
      writeFileSync(join(workDir, name), buf, { mode: 0o600, flag: 'wx' });
      result[label][name] = sha256(buf);
    }
  }
  return result;
}

const text = (buf) => buf.toString('utf8');
const isStub = (buf) => stubTarget(text(buf)) !== null;

// "Before" is the live folder, which is what the snapshot was taken from; liveDiffers is what
// tells whether it still is. "After" is the live folder with the accepted changes applied.
function unlisted(files) {
  const index = files.get(INDEX);
  const refs = indexRefs(index ? text(index) : '');
  let n = 0;
  for (const [name, buf] of files) {
    if (name !== INDEX && !isStub(buf) && !refs.has(name)) n += 1;
  }
  return n;
}

export function evaluate({ pairs, snap, allowRetire }) {
  const errors = [];
  const changes = [];
  const ignored = [];
  const stats = {};
  const work = {};
  for (const { label, workDir } of pairs) {
    const { files, other } = scanDir(workDir);
    work[label] = files;
    for (const name of other) errors.push(`${label}/${name}: not a regular note file`);
  }

  for (const { label } of pairs) {
    const known = snap[label] ?? {};
    for (const [name, buf] of work[label]) {
      if (known[name] === sha256(buf)) continue;
      const where = `${label}/${name}`;
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
        if (problem) errors.push(`${where}: ${problem}`);
        else changes.push({ label, file: name, kind: 'retire', target: { label: targetLabel, file: targetFile } });
        continue;
      }
      if (buf.length > MAX_NOTE_BYTES) {
        errors.push(`${where}: note is larger than ${MAX_NOTE_BYTES} bytes`);
        continue;
      }
      if (scanText(text(buf)).length > 0) {
        errors.push(`${where}: note contains text that looks like a credential`);
        continue;
      }
      changes.push({ label, file: name, kind: isNew ? 'add' : 'change' });
    }
  }

  for (const { label, liveDir } of pairs) {
    const before = scanDir(liveDir).files;
    const after = new Map(before);
    for (const c of changes) {
      if (c.label !== label) continue;
      if (c.kind === 'retire') after.delete(c.file);
      else after.set(c.file, work[label].get(c.file));
    }
    const indexBefore = indexStats(before.has(INDEX) ? text(before.get(INDEX)) : '');
    const indexAfter = indexStats(after.has(INDEX) ? text(after.get(INDEX)) : '');
    const unlistedBefore = unlisted(before);
    const unlistedAfter = unlisted(after);
    stats[label] = { indexBefore, indexAfter, unlistedBefore, unlistedAfter };
    if (unlistedAfter > unlistedBefore) {
      errors.push(`${label}/${INDEX}: more notes without an index line than before`);
    }
    const index = after.get(INDEX);
    if (index && text(index).trim() === '' && [...after].some(([n, b]) => n !== INDEX && !isStub(b))) {
      errors.push(`${label}/${INDEX}: the index may not be emptied while notes remain`);
    }
  }
  return { ok: errors.length === 0, errors, changes, ignored, stats };
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

function writeAtomic(dir, name, buf) {
  const dest = join(dir, name);
  let mode = 0o644;
  try {
    const st = lstatSync(dest);
    if (st.isFile()) mode = st.mode & 0o777;
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  const tmp = join(dir, `${name}.tmp.${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, buf, { mode, flag: 'wx' });
    renameSync(tmp, dest);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* temporary file may not exist */ }
    throw err;
  }
}

export function apply({ pairs, changes }) {
  const byLabel = new Map(pairs.map((p) => [p.label, p]));
  const pairOf = (label) => {
    const pair = byLabel.get(label);
    if (!pair) throw new Error(`unknown folder: ${label}`);
    return pair;
  };
  const written = new Set();
  const writes = [];
  const retires = [];
  for (const c of changes) {
    const pair = pairOf(c.label);
    if (!NOTE_NAME_RE.test(c.file)) throw new Error(`${c.label}/${c.file}: not a note file name`);
    if (c.kind === 'add' || c.kind === 'change') {
      const buf = readRegular(join(pair.workDir, c.file));
      if (!buf) throw new Error(`${c.label}/${c.file}: work file is not a regular file`);
      writes.push({ pair, file: c.file, buf });
      written.add(`${c.label}/${c.file}`);
    } else if (c.kind === 'retire') {
      retires.push(c);
    } else {
      throw new Error(`${c.label}/${c.file}: unknown change kind`);
    }
  }
  // Check every retirement before anything is written or deleted.
  for (const c of retires) {
    const pair = pairOf(c.label);
    const buf = readRegular(join(pair.workDir, c.file));
    if (c.file === INDEX || !buf || !isStub(buf)) throw new Error(`${c.label}/${c.file}: work file is not a stub`);
    const t = c.target;
    if (!t || !NOTE_NAME_RE.test(t.file) || t.file === INDEX || (t.label === c.label && t.file === c.file)) {
      throw new Error(`${c.label}/${c.file}: invalid retirement target`);
    }
    const targetPair = pairOf(t.label);
    const present = written.has(`${t.label}/${t.file}`) || readRegular(join(targetPair.liveDir, t.file)) !== null;
    if (!present) throw new Error(`${c.label}/${c.file}: retirement target is not present`);
  }
  for (const { pair, file, buf } of writes) {
    mkdirSync(pair.liveDir, { recursive: true });
    writeAtomic(pair.liveDir, file, buf);
  }
  for (const c of retires) {
    try {
      unlinkSync(join(pairOf(c.label).liveDir, c.file));
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
}
