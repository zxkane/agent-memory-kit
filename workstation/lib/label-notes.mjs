// The label step in the notes clone: the notes of a scope folder as the step lists them, and
// writing their labels. File-system logic only; no Git and no model. A note file that is a link is
// never read, and labels are written only into real folders, never through a link.

import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { LABELS, readDomain, setDomain } from './domains.mjs';
import { INDEX, NOTE_NAME_RE, parseNote, stubTarget } from './notes.mjs';
import { bodyOf, noteFiles, readRegular, writeAtomic } from './workdir.mjs';

// The model sees a note's body up to NOTE_TEXT_CAP characters, followed by CUT_MARKER when it is longer.
export const NOTE_TEXT_CAP = 6000;
export const CUT_MARKER = '\n[... cut at 6,000 characters]';

// A second version of a note that the sync kept (CONFLICT_RE in consolidate.mjs).
const CONFLICT_RE = /\.conflict-[^/]*\.md$/;
const HASH_RE = /^[0-9a-f]{64}$/;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const isMissing = (err) => err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const capped = (text) => (text.length > NOTE_TEXT_CAP ? `${text.slice(0, NOTE_TEXT_CAP)}${CUT_MARKER}` : text);

// The notes of a scope folder that the label step takes, sorted by file name: its regular note
// files except the index, a retired note (a `MOVED TO` stub) and a conflict copy. `scope` is
// `global` or `projects/<name>`. `skip` is why setDomain cannot label the note (null when it can).
export function collectScopeNotes(dir, scope) {
  const notes = [];
  for (const [file, buf] of noteFiles(dir)) {
    const text = buf.toString('utf8');
    if (file === INDEX || CONFLICT_RE.test(file) || stubTarget(text) !== null) continue;
    const { name, description } = parseNote(text);
    notes.push({
      path: `${scope}/${file}`, scope, file, sha256: sha256(buf), domain: readDomain(text), name, description,
      body: capped(bodyOf(text)), skip: setDomain(text, 'general').skip ?? null,
    });
  }
  return notes;
}

// Why an entry of a label plan cannot be applied, or null. Its path is `global/<note>` or
// `projects/<name>/<note>`, the note a file other than the index; its label is one of LABELS and its
// sha256 the digest, in lower-case hex, of the note as it was read.
export function labelEntryProblem(entry) {
  if (!isObject(entry)) return 'not an object';
  const parts = typeof entry.path === 'string' ? entry.path.split('/') : [];
  const file = parts.at(-1) ?? '';
  const inScope = (parts.length === 2 && parts[0] === 'global')
    || (parts.length === 3 && parts[0] === 'projects' && !['', '.', '..'].includes(parts[1]));
  if (!inScope || !NOTE_NAME_RE.test(file)) return 'the path is not a note of global/ or of a project folder';
  if (file === INDEX) return 'MEMORY.md is the index, not a note';
  if (!LABELS.includes(entry.label)) return 'the label is not work, personal or general';
  if (typeof entry.sha256 !== 'string' || !HASH_RE.test(entry.sha256)) return 'sha256 is not 64 hexadecimal characters';
  return null;
}

// `<repoDir>/<folders...>` when each of those folders is a real folder (never a link); null otherwise.
function realFolder(repoDir, folders) {
  let dir = repoDir;
  for (const name of folders) {
    dir = join(dir, name);
    let st = null;
    try {
      st = lstatSync(dir);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    if (!st?.isDirectory()) return null;
  }
  return dir;
}

// Labels one note: `{ written: <new digest> }`, `{ unchanged: true }` or `{ reason }` (skipped).
function labelNote(repoDir, { path, label, sha256: digest }) {
  const folders = path.split('/');
  const file = folders.pop();
  const dir = realFolder(repoDir, folders);
  const info = {};
  const buf = dir === null ? null : readRegular(join(dir, file), info);
  if (buf === null) return { reason: 'gone' };
  if (sha256(buf) !== digest) return { reason: 'changed since it was read' };
  const text = buf.toString('utf8');
  if (readDomain(text) === label) return { unchanged: true };
  // Decoding replaces bytes that are not UTF-8: the text written back would not keep them.
  if (!Buffer.from(text, 'utf8').equals(buf)) return { reason: 'not UTF-8 text' };
  const set = setDomain(text, label);
  if (set.skip) return { reason: set.skip };
  const bytes = Buffer.from(set.text, 'utf8');
  writeAtomic(dir, file, bytes, info.mode);
  return { written: sha256(bytes) };
}

// Writes each entry's label into its note, in order, only while the note is the one that was read
// (its SHA-256 is the entry's); a note that has the label already is left as it is. Every entry is
// checked first: one that labelEntryProblem refuses throws a TypeError and nothing is written. Each
// note is replaced atomically and keeps its mode. An error after the first write is tagged
// `partial`, with what was done so far in `err.result`.
export function applyLabelEntries(repoDir, entries) {
  entries.forEach((entry, i) => {
    const problem = labelEntryProblem(entry);
    if (problem) throw new TypeError(`label entry ${i + 1}: ${problem}`);
  });
  const result = { written: [], unchanged: [], skipped: [] };
  try {
    for (const entry of entries) {
      const r = labelNote(repoDir, entry);
      if (r.written) result.written.push({ path: entry.path, sha256: r.written });
      else if (r.unchanged) result.unchanged.push({ path: entry.path, sha256: entry.sha256 });
      else result.skipped.push({ path: entry.path, reason: r.reason });
    }
  } catch (err) {
    if (result.written.length > 0) Object.assign(err, { partial: true, result });
    throw err;
  }
  return result;
}
