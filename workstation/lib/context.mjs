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

// Sync health lines shared by both context builders: stale sync, quarantine,
// marker conflicts, conflict count.
function statusLines(config, status, now) {
  const { stateDir, staleAfterSeconds } = config;
  const lines = [];
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
  return lines;
}

// The text a session sees at start. Never longer than `cap` characters.
// `unusableName`: the directory is a repository whose name cannot be a project name.
// `linkSkipped`: the reason ensureLink gave for not linking the memory folder, or null.
export function buildSessionContext({
  config, status, project, repoOk, identity, unusableName = false, linkSkipped = null, now = new Date(), cap = DEFAULT_CAP,
}) {
  const { repoDir } = config;
  if (!repoOk) {
    return capped(unusableCloneWarning(repoDir), cap);
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
  lines.push(...statusLines(config, status, now));
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

// Budget for Codex and Kiro hook output, measured by textCost.
export const TOOL_BUDGET = 7200;

// Rough token cost: 1 per ASCII code unit (three per token), 5 per other code unit.
export function textCost(text) {
  let cost = 0;
  for (let i = 0; i < text.length; i++) cost += text.charCodeAt(i) <= 0x7f ? 1 : 5;
  return cost;
}

function readLines(path) {
  try {
    const text = readFileSync(path, 'utf8').trimEnd();
    return text === '' ? [] : text.split('\n');
  } catch {
    return [];
  }
}

const NO_PROJECT_REASONS = {
  'not-a-repository': () => 'This directory is not inside a Git repository, so it has no project notes.',
  'unusable-name': () => "This repository's directory name cannot be used as a project name, so it has no project notes.",
  'no-identity': () => 'This repository has no shareable "origin" remote, so it has no project notes.',
  mismatch: (expected) => `This repository shares its name with another project in shared memory${expected === null ? '' : ` (${shortIdentity(expected)})`}, so it has no project notes.`,
};

// Lines of `text` that fit in `allowance` cost units, each line counted with its
// newline. When not all fit, a truncation footer is appended and counted too.
function fitIndex(lines, path, allowance) {
  const lineCost = (l) => textCost(l) + 1;
  if (lines.reduce((sum, l) => sum + lineCost(l), 0) <= allowance) return lines;
  const footer = `[truncated; full index: ${path}]`;
  let room = allowance - lineCost(footer);
  if (room < 0) return [];
  const kept = [];
  for (const line of lines) {
    if (lineCost(line) > room) break;
    kept.push(line);
    room -= lineCost(line);
  }
  return [...kept, footer];
}

// The text a Codex or Kiro session sees at start. Its textCost never exceeds `budget`.
// `project`: the bound project name, or null; `reason` says why it is null.
export function buildToolContext({
  config, status, project, repoOk, reason = null, expected = null, now = new Date(), budget = TOOL_BUDGET,
}) {
  const { repoDir } = config;
  if (!repoOk) return unusableCloneWarning(repoDir);

  const globalPath = `${repoDir}/global/MEMORY.md`;
  const projectPath = project === null ? null : `${repoDir}/projects/${project}/MEMORY.md`;
  const head = [
    `Shared memory is on. Notes under ${repoDir} are synced between machines every few minutes.`,
    project === null
      ? `Notes for all projects: ${repoDir}/global/.`
      : `Project notes for this repository: ${repoDir}/projects/${project}/ — notes for all projects: ${repoDir}/global/.`,
    'To remember a fact, add one Markdown file with `name`, `description` and `metadata.type` (user, feedback, project or reference) frontmatter, and one line for it in that folder\'s MEMORY.md. Open a note when its index line is relevant.',
  ];
  if (project === null && NO_PROJECT_REASONS[reason]) head.push(NO_PROJECT_REASONS[reason](expected));
  head.push(...statusLines(config, status, now));

  const sections = [];
  if (project !== null) sections.push({ title: `Project index (${projectPath}):`, path: projectPath, lines: readLines(projectPath) });
  sections.push({ title: `Global index (${globalPath}):`, path: globalPath, lines: readLines(globalPath) });

  // Fixed text: everything except index lines (an empty index shows its placeholder).
  const fixedParts = [`${head.join('\n')}\n`];
  for (const s of sections) fixedParts.push(`${s.title}\n`, ...(s.lines.length === 0 ? ['(empty)\n'] : []));
  const fixed = fixedParts.join('');
  const left = budget - textCost(fixed);
  if (left < 0) {
    let cost = 0;
    let end = 0;
    while (end < fixed.length && cost + (fixed.charCodeAt(end) <= 0x7f ? 1 : 5) <= budget) {
      cost += fixed.charCodeAt(end) <= 0x7f ? 1 : 5;
      end++;
    }
    return fixed.slice(0, end);
  }

  const fullCost = (s) => s.lines.reduce((sum, l) => sum + textCost(l) + 1, 0);
  const share = Math.floor(left / 2);
  const allowance = sections.map(() => share);
  if (sections.length === 2) {
    if (fullCost(sections[0]) <= share) allowance[1] = left - fullCost(sections[0]);
    else if (fullCost(sections[1]) <= share) allowance[0] = left - fullCost(sections[1]);
  } else {
    allowance[0] = left;
  }

  const out = [`${head.join('\n')}\n`];
  sections.forEach((s, i) => {
    out.push(`${s.title}\n`);
    if (s.lines.length === 0) out.push('(empty)\n');
    else out.push(...fitIndex(s.lines, s.path, allowance[i]).map((l) => `${l}\n`));
  });
  return out.join('');
}

function unusableCloneWarning(repoDir) {
  return `WARNING: shared memory is enabled but ${repoDir} is not a usable clone. Notes written now stay local. Run setup.sh from agent-memory-kit.\n`;
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
