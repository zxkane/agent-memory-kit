// The run log of consolidation: `<stateDir>/runs.jsonl`, one JSON line for each run of `run.sh
// consolidate extract|organize|label`, also with `--agents`, when it ends, whatever it did: a run
// with nothing to do, a dry run, a run that stopped at a limit and a run that failed add theirs too.
// A line holds names, outcomes, figures and fixed words, never a message: no response body, no
// credential. The log is machine-local (mode 0600 in the state folder) and never committed. Lines
// are added under the consolidation lock, which run.sh holds for the whole run; adding one drops
// the lines that ended more than RUN_LOG_KEEP_DAYS days before. A line that is not a run line (not
// JSON, another form) is kept as it is, for the report to name it.

import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRegular } from './workdir.mjs';

// The version of the lines' form. It changes only with a change that breaks a reader.
export const RUN_LOG_SCHEMA_VERSION = 1;
export const RUN_LOG_KEEP_DAYS = 90;
export const RUN_LOG = 'runs.jsonl';
const DAY_MS = 24 * 3600 * 1000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMissing = (err) => err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');

// When the run of a line ended (its `endedAt`, in ms), or null when the line does not say.
function endedAt(value) {
  const t = isObject(value) && typeof value.endedAt === 'string' ? Date.parse(value.endedAt) : NaN;
  return Number.isFinite(t) ? t : null;
}

function parsed(raw) {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return null;
  }
}

// The text of the log, '' when there is none. One that is not a regular file (a link, a folder)
// is never read or replaced.
function readLog(file) {
  let st = null;
  try {
    st = lstatSync(file);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  if (st === null) return '';
  const buf = st.isFile() ? readRegular(file) : null;
  if (buf === null) throw new Error(`${RUN_LOG} is not a regular file`);
  return buf.toString('utf8');
}

// Adds `line` (an object) to the log of `stateDir` at `now` and drops the lines that ended more
// than RUN_LOG_KEEP_DAYS days before. The log is written whole to a new file that then replaces it,
// so that a reader never sees part of a line.
export function appendRunLine(stateDir, line, now = new Date()) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, RUN_LOG);
  const cutoff = now.getTime() - RUN_LOG_KEEP_DAYS * DAY_MS;
  const kept = readLog(file).split('\n').filter((raw) => {
    if (raw.trim() === '') return false;
    const ended = endedAt(parsed(raw)?.value);
    return ended === null || ended >= cutoff;
  });
  const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, `${[...kept, JSON.stringify(line)].join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// The log of `stateDir`: `runs`, its run lines (an object of schemaVersion 1 with an end time) in
// the order they were added, and `problems`, one `{ file, line, problem }` for each line that is
// not one (or `line: null` for a log that cannot be read). A missing log has neither.
export function readRunLog(stateDir) {
  const out = { runs: [], problems: [] };
  let text;
  try {
    text = readLog(join(stateDir, RUN_LOG));
  } catch {
    out.problems.push({ file: RUN_LOG, line: null, problem: 'the run log cannot be read' });
    return out;
  }
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    const p = parsed(raw);
    let problem = null;
    if (p === null) problem = 'not valid JSON';
    else if (!isObject(p.value) || p.value.schemaVersion !== RUN_LOG_SCHEMA_VERSION || endedAt(p.value) === null) problem = 'not a run line of schemaVersion 1';
    if (problem) out.problems.push({ file: RUN_LOG, line: i + 1, problem });
    else out.runs.push(p.value);
  });
  return out;
}
