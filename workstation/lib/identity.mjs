import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_MARKER = '.project';

// Matches the notes repository's ignore pattern `*.tmp.*`.
export function markerTempName() {
  return `${PROJECT_MARKER}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
}

// The marker's raw content, or null when there is no marker.
function readMarkerText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// The identity recorded in the marker; empty or blank content counts as none.
const readMarker = (path) => readMarkerText(path)?.trim() || null;

// Codes with which a file system that has no hard links refuses linkSync.
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV']);

// Puts the content of `src` at `dest` without ever replacing `dest`: through a hard link
// where the file system has them, otherwise by creating `dest` exclusively. Throws EEXIST
// when `dest` exists.
function placeWithoutReplacing(link, src, dest) {
  try {
    link(src, dest);
  } catch (err) {
    if (!NO_HARD_LINKS.has(err.code)) throw err;
    writeFileSync(dest, readFileSync(src), { flag: 'wx' });
  }
}

function compare(recorded, identity) {
  if (recorded === identity) return { ok: true, reason: 'match', expected: null };
  return { ok: false, reason: 'mismatch', expected: recorded };
}

// Moves a blank marker out of the way so that it can be replaced. Only one of
// several racing sessions gets the file. If what was taken turns out to hold an
// identity (published in between), it is put back without overwriting.
function clearBlankMarker(marker, dir, link) {
  const claimed = join(dir, markerTempName());
  try {
    renameSync(marker, claimed);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  try {
    if (readMarker(claimed) !== null) {
      try {
        placeWithoutReplacing(link, claimed, marker);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  } finally {
    rmSync(claimed, { force: true });
  }
}

// Publishes the marker without ever replacing one: the link fails with EEXIST
// when the marker exists, so the first session to publish wins and the file
// never appears partly written. Returns true when this call created it.
function publish(marker, dir, identity, link) {
  const temp = join(dir, markerTempName());
  try {
    writeFileSync(temp, `${identity}\n`);
    try {
      placeWithoutReplacing(link, temp, marker);
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

// Ties a project folder to the repository that owns it. The marker is an
// ordinary file in the notes clone, so the binding travels with the sync.
// A repository without an identity (no shareable `origin`) cannot be told apart
// from another one with the same directory name, so it is refused. A refused
// repository never creates the folder.
// `steps` lets tests act between the stages of a bind; `steps.link` replaces linkSync.
export function bindProject(targetDir, identity, steps = {}) {
  if (identity === null) return { ok: false, reason: 'no-identity', expected: null };
  const marker = join(targetDir, PROJECT_MARKER);
  const link = steps.link ?? linkSync;
  // A folder that refuses this identity already exists: it holds the marker.
  mkdirSync(targetDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const text = readMarkerText(marker);
    const recorded = text?.trim() || null;
    if (recorded !== null) return compare(recorded, identity);

    // Only a marker that was read as blank is moved away; one that was absent may have been
    // published since by another session and must not be taken.
    if (text !== null) clearBlankMarker(marker, targetDir, link);
    steps.beforePublish?.(marker);
    const created = publish(marker, targetDir, identity, link);
    steps.afterPublish?.(marker);

    const current = readMarker(marker);
    if (current === null) continue; // removed in between: look again
    if (created && current === identity) return { ok: true, reason: 'bound', expected: null };
    return compare(current, identity);
  }
  return { ok: false, reason: 'mismatch', expected: null };
}
