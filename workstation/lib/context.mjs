import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  ALL_STATUS_WORDS, AWS_ERROR_RE, BRIDGE_DOWN_REASONS, FIELD_RE, NOT_USABLE, OWN_ERROR_TEXTS, realIsoTime,
} from './bridge-text.mjs';
import { canaryReason } from './canary-text.mjs';

export { BRIDGE_DOWN_REASONS };

const DEFAULT_CAP = 9000;

function readGlobalIndex(repoDir) {
  try {
    return readFileSync(join(repoDir, 'global', 'MEMORY.md'), 'utf8');
  } catch {
    return '';
  }
}

// The sync's last success as a checked time (real, and not in the future), or null.
function syncSince(status, now) {
  return realIsoTime(status?.lastSuccess, now);
}

function lastSuccessIsStale(status, staleAfterSeconds, now) {
  const since = syncSince(status, now);
  return since === null || now.getTime() - Date.parse(since) > staleAfterSeconds * 1000;
}

// A count from a status file: a safe integer above 0 is printed (at most 9,999, larger is "more than
// 9,999"); anything else is 0 and gives no line.
function countText(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value > 9999 ? 'more than 9,999' : String(value);
}

// An identity read from a marker file (written by another machine) in the shape of `host/path`.
const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9._~@+:-]*(\/[A-Za-z0-9._~@+%:-]+)*$/;
const safeIdentity = (text) => {
  const first = shortIdentity(text);
  return IDENTITY_RE.test(first) ? first : 'unknown';
};
// The reason ensureLink gave for not linking: lower-case words and hyphens.
const safeLinkReason = (text) => (typeof text === 'string' && /^[a-z-]{1,30}$/.test(text) ? text : 'unknown');

// An identity read from a marker file: its first line, at most 200 characters.
const shortIdentity = (text) => String(text).split(/\r?\n/)[0].slice(0, 200);

const capped = (text, cap) => (text.length <= cap ? text : text.slice(0, cap));

// ---- Bridge health. Only text that passes a strict check is put into a line: a time, a status
// word, an AwsError message or a fixed text of bridge down. Anything else is the word "failed".

const BRIDGE_DOWN_FIXED = new Set(BRIDGE_DOWN_REASONS);
const BRIDGE_WORDS = new Set([...ALL_STATUS_WORDS, ...OWN_ERROR_TEXTS]);

const safeReason = (value) => {
  if (typeof value !== 'string') return 'failed';
  return BRIDGE_WORDS.has(value) || AWS_ERROR_RE.test(value) || BRIDGE_DOWN_FIXED.has(value) ? value : 'failed';
};

const HINTS = {
  diverged: 'Clone the notes repository afresh.',
  'not-synced': 'This clone holds commits the remote does not; check that the sync succeeds.',
};
const UNUSABLE_HINT = 'Check the agents clone and its marker file .agent-memory-mirror.';

// The time a step has been failing since, as printed: its last success when that is a valid time;
// when the last success is there but not valid (a clock correction), the start of the failures when
// that is valid; otherwise null ("it was set up").
function stepSince(step, now) {
  const ok = realIsoTime(step.lastSuccess, now);
  if (ok !== null || step.lastSuccess == null) return ok;
  return realIsoTime(step.failingSince, now);
}

// A step's failure has lasted past the stale window: its last success is missing or older than the
// window; with no success at all, the first failed run is what counts.
function stepIsStale(step, staleAfterSeconds, now) {
  const since = stepSince(step, now) ?? (step.lastSuccess == null ? realIsoTime(step.failingSince, now) : null);
  if (since === null) return true;
  return now.getTime() - Date.parse(since) > staleAfterSeconds * 1000;
}

function bridgeLines(config, status, now) {
  const lines = [];
  const problem = config.bridgeProblem;
  if (typeof problem === 'string' && problem !== '') {
    lines.push(`WARNING: the bridge block in the agent-memory config is invalid (${FIELD_RE.test(problem) ? problem : 'unknown'}); the bridge is off.`);
  }
  const bridge = config.bridge ?? null;
  const steps = status?.bridge;
  if (bridge === null || steps === null || typeof steps !== 'object') return lines;
  const configured = { up: bridge.up === true, down: typeof bridge.agentsRepoDir === 'string' && bridge.agentsRepoDir !== '' };
  for (const [key, label] of [['up', 'to S3'], ['down', 'agent notes']]) {
    const step = steps[key];
    if (!configured[key] || step === null || typeof step !== 'object' || step.ok !== false) continue;
    if (!stepIsStale(step, config.staleAfterSeconds, now)) continue;
    const reason = safeReason(step.error);
    const hint = reason.startsWith(NOT_USABLE) ? UNUSABLE_HINT : (HINTS[reason] ?? null);
    lines.push(`WARNING: the memory bridge (${label}) has not succeeded since ${stepSince(step, now) ?? 'it was set up'}: ${reason}.${hint ? ` ${hint}` : ''}`);
  }
  return lines;
}

// ---- Canary health. The record is a file on disk, so only a real time, a number list or an error
// text that passes its check is put into a line; anything else is a fixed word.

const CANARY_STALE_MS = 3 * 24 * 3600 * 1000;

// canary.json as an object, or null when there is no file; a file that cannot be read as a record
// is an empty record (it counts as a failed run of an unknown time).
function readCanary(stateDir) {
  let text;
  try {
    text = readFileSync(join(stateDir, 'canary.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    const record = JSON.parse(text);
    return record !== null && typeof record === 'object' && !Array.isArray(record) ? record : {};
  } catch {
    return {};
  }
}

function canaryLines(config, now) {
  const problem = config.canaryProblem;
  if (typeof problem === 'string' && problem !== '') {
    return [`WARNING: the canary block in the agent-memory config is invalid (${FIELD_RE.test(problem) ? problem : 'unknown'}); the canary is off.`];
  }
  const canary = config.canary ?? null;
  if (canary === null) return [];
  const record = readCanary(config.stateDir);
  if (record === null) {
    // A schedule and no result yet: the timer has not run (setup.sh not run again, units not
    // enabled, a schedule systemd rejected, a run that stops before it records anything).
    return typeof canary.schedule === 'string' && canary.schedule !== '' ? ['WARNING: the memory API canary is configured but has not run yet.'] : [];
  }
  if (record.ok !== true) {
    return [`WARNING: the memory API canary failed at ${realIsoTime(record.lastRun, now) ?? 'an unknown time'}: ${canaryReason(record)}.`];
  }
  if (typeof canary.schedule !== 'string' || canary.schedule === '') return [];
  const since = realIsoTime(record.lastSuccess, now);
  if (since !== null && now.getTime() - Date.parse(since) <= CANARY_STALE_MS) return [];
  return [`WARNING: the memory API canary has not passed since ${since ?? 'it was set up'}.`];
}

// Sync health lines shared by both context builders: stale sync, bridge health, canary health,
// quarantine, marker conflicts, conflict count.
function statusLines(config, status, now) {
  const { stateDir, staleAfterSeconds } = config;
  const lines = [];
  if (lastSuccessIsStale(status, staleAfterSeconds, now)) {
    lines.push(`WARNING: memory sync has not succeeded since ${syncSince(status, now) ?? 'it was set up'}. Notes written now stay on this machine until it recovers.`);
  }
  lines.push(...bridgeLines(config, status, now));
  lines.push(...canaryLines(config, now));
  const quarantined = countText(status?.quarantineCount);
  if (quarantined !== null) {
    lines.push(`WARNING: the secret scan set aside ${quarantined} file(s) in ${stateDir}/quarantine. Review them.`);
  }
  const markerConflicts = Array.isArray(status?.markerConflicts) ? Math.min(status.markerConflicts.length, 9999) : 0;
  if (markerConflicts > 0) {
    lines.push(`WARNING: ${markerConflicts} project folder(s) were claimed by a different repository on another machine. Notes written here before that may be mixed in; see ${stateDir}/status.json.`);
  }
  const conflicts = countText(status?.conflictCount);
  if (conflicts !== null) {
    lines.push(`Note: ${conflicts} note(s) changed on two machines; both versions were kept as *.conflict-*.md.`);
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
    lines.push(`This repository's memory folder could not be linked (${safeLinkReason(linkSkipped)}), so its memory stays on this machine.`);
  }
  if (identity?.reason === 'mismatch') {
    const expected = safeIdentity(identity.expected);
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

// Rough token cost of one UTF-16 code unit: 1 for ASCII (three per token), 5 for any other.
const unitCost = (code) => (code <= 0x7f ? 1 : 5);

export function textCost(text) {
  let cost = 0;
  for (let i = 0; i < text.length; i++) cost += unitCost(text.charCodeAt(i));
  return cost;
}

// The longest prefix of `text` that, with a final newline, costs at most `budget`. It never
// ends between the two halves of a surrogate pair.
function cutToBudget(text, budget) {
  if (budget < 1) return '';
  let cost = 0;
  let end = 0;
  while (end < text.length && cost + unitCost(text.charCodeAt(end)) <= budget - 1) {
    cost += unitCost(text.charCodeAt(end));
    end++;
  }
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  const cut = text.slice(0, end);
  return cut.endsWith('\n') ? cut : `${cut}\n`;
}

const withinBudget = (text, budget) => (textCost(text) <= budget ? text : cutToBudget(text, budget));

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
  mismatch: (expected) => `This repository shares its name with another project in shared memory${expected === null ? '' : ` (${safeIdentity(expected)})`}, so it has no project notes.`,
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

// The text a Codex or Kiro session sees at start, ending in a newline. Its textCost never
// exceeds `budget`.
// `project`: the bound project name, or null; `reason` says why it is null.
export function buildToolContext({
  config, status, project, repoOk, reason = null, expected = null, now = new Date(), budget = TOOL_BUDGET,
}) {
  const { repoDir } = config;
  if (!repoOk) return withinBudget(unusableCloneWarning(repoDir), budget);

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
  if (left < 0) return cutToBudget(fixed, budget);

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
