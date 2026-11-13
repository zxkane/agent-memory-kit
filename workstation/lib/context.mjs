import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

const DEFAULT_CAP = 9000;

function readGlobalIndex(repoDir) {
  try {
    return readFileSync(join(repoDir, 'global', 'MEMORY.md'), 'utf8');
  } catch {
    return '';
  }
}

function lastSuccessIsStale(status, staleAfterSeconds, now) {
  if (!status?.lastSuccess) return true;
  const at = Date.parse(status.lastSuccess);
  return Number.isNaN(at) || now.getTime() - at > staleAfterSeconds * 1000;
}

// An identity read from a marker file: its first line, at most 200 characters.
const shortIdentity = (text) => String(text).split(/\r?\n/)[0].slice(0, 200);

const capped = (text, cap) => (text.length <= cap ? text : text.slice(0, cap));

// The text a session sees at start. Never longer than `cap` characters.
// `unusableName`: the directory is a repository whose name cannot be a project name.
// `linkSkipped`: the reason ensureLink gave for not linking the memory folder, or null.
export function buildSessionContext({
  config, status, project, repoOk, identity, unusableName = false, linkSkipped = null, now = new Date(), cap = DEFAULT_CAP,
}) {
  const { repoDir, stateDir, staleAfterSeconds } = config;
  if (!repoOk) {
    return capped(`WARNING: shared memory is enabled but ${repoDir} is not a usable clone. Notes written now stay local. Run setup.sh from agent-memory-kit.\n`, cap);
  }
  const lines = [
    `Shared memory is on. Notes under ${repoDir} are synced between machines every few minutes.`,
    `Facts that apply across projects belong in ${repoDir}/global/, in the same format as project memory: one fact per file plus one line in MEMORY.md.`,
  ];
  if (project === null) {
    lines.push(unusableName
      ? "This repository's directory name cannot be used as a project name, so its memory stays on this machine."
      : 'This directory is not inside a Git repository, so its memory stays on this machine.');
  }
  if (identity?.reason === 'no-identity') {
    lines.push('This repository has no shareable "origin" remote, so its memory stays on this machine.');
  }
  if (linkSkipped) {
    lines.push(`This repository's memory folder could not be linked (${linkSkipped}), so its memory stays on this machine.`);
  }
  if (identity?.reason === 'mismatch') {
    const expected = shortIdentity(identity.expected);
    lines.push(identity.linked
      ? `WARNING: this repository's remote no longer matches the project its memory is linked to (${expected}).`
      : `This repository shares its name with another project in shared memory (${expected}), so its memory stays on this machine.`);
  }
  if (lastSuccessIsStale(status, staleAfterSeconds, now)) {
    lines.push(`WARNING: memory sync has not succeeded since ${status?.lastSuccess || 'it was set up'}. Notes written now stay on this machine until it recovers.`);
  }
  if (status?.quarantineCount > 0) {
    lines.push(`WARNING: the secret scan set aside ${status.quarantineCount} file(s) in ${stateDir}/quarantine. Review them.`);
  }
  const markerConflicts = Array.isArray(status?.markerConflicts) ? status.markerConflicts.length : 0;
  if (markerConflicts > 0) {
    lines.push(`WARNING: ${markerConflicts} project folder(s) were claimed by a different repository on another machine. Notes written here before that may be mixed in; see ${stateDir}/status.json.`);
  }
  if (status?.conflictCount > 0) {
    lines.push(`Note: ${status.conflictCount} note(s) changed on two machines; both versions were kept as *.conflict-*.md.`);
  }
  lines.push('Global index:');
  const header = `${lines.join('\n')}\n`;

  const index = readGlobalIndex(repoDir).trimEnd();
  if (index === '') return capped(`${header}(empty)\n`, cap);
  if (header.length + index.length + 1 <= cap) return `${header}${index}\n`;

  const footer = `[truncated; full index: ${repoDir}/global/MEMORY.md]\n`;
  let budget = cap - header.length - footer.length;
  const kept = [];
  for (const line of index.split('\n')) {
    if (line.length + 1 > budget) break;
    kept.push(line);
    budget -= line.length + 1;
  }
  // When the fixed lines alone are too long, the text is cut to the cap.
  return capped(`${header}${kept.map((l) => `${l}\n`).join('')}${footer}`, cap);
}

// True when filePath, followed through symbolic links, lies inside dir. The file
// itself may not exist yet: its nearest existing ancestor is resolved instead.
export function isInside(filePath, dir) {
  try {
    let head = resolve(filePath);
    const tail = [];
    for (;;) {
      try {
        head = realpathSync(head);
        break;
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
        const parent = dirname(head);
        if (parent === head) return false;
        tail.unshift(basename(head));
        head = parent;
      }
    }
    const real = join(head, ...tail);
    const root = realpathSync(dir);
    return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
  } catch {
    return false;
  }
}

// Appends one line to <stateDir>/hook-errors.log. Callers pass a fixed or
// file-system message, never hook input or scanned text. Failures are ignored.
export function logHookError(stateDir, driver, message, now = new Date()) {
  try {
    const text = String(message).split('\n')[0].slice(0, 300);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    appendFileSync(join(stateDir, 'hook-errors.log'), `${now.toISOString()} ${driver} ${text}\n`, { mode: 0o600 });
  } catch {
    // Nothing more can be done.
  }
}
