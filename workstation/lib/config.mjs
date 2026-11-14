import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const HOST_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const CALENDAR_RE = /^[A-Za-z0-9 *:,./~-]{1,80}$/;

function intIn(value, fallback, min, max) {
  const v = value === undefined ? fallback : value;
  return Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

function calendar(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && CALENDAR_RE.test(value) && value.trim() !== '' ? value : undefined;
}

// The optional consolidation block: `{ value, problem }`. An absent block gives no value and no
// problem. A present block that is not valid gives no value (consolidation stays off; it never
// disables the rest of the config) and, as `problem`, the name of the first field that failed
// (`consolidate` when the block is not an object), so that the driver and setup can say so.
function parseConsolidate(block) {
  if (block === undefined || block === null) return { value: null, problem: null };
  const bad = (problem) => ({ value: null, problem });
  if (typeof block !== 'object' || Array.isArray(block)) return bad('consolidate');
  const { command, model } = block;
  if (typeof command !== 'string' || !isAbsolute(command) || CONTROL_RE.test(command)) return bad('command');
  if (typeof model !== 'string' || !/^\S+$/.test(model)) return bad('model');
  const env = block.env ?? {};
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return bad('env');
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME_RE.test(k) || typeof v !== 'string' || CONTROL_RE.test(v)) return bad('env');
  }
  const budget = block.maxBudgetUsd ?? 5;
  const fields = {
    extract: calendar(block.extract),
    organize: calendar(block.organize),
    maxProjects: intIn(block.maxProjects, 5, 1, 50),
    maxTranscriptBytes: intIn(block.maxTranscriptBytes, 200000, 10000, 2000000),
    maxTurns: intIn(block.maxTurns, 200, 1, 1000),
    timeoutMinutes: intIn(block.timeoutMinutes, 30, 1, 240),
    maxBudgetUsd: typeof budget === 'number' && budget > 0 && budget <= 100 ? budget : undefined,
  };
  for (const [name, value] of Object.entries(fields)) if (value === undefined) return bad(name);
  const { extract, organize, maxProjects, maxTranscriptBytes, maxTurns, maxBudgetUsd, timeoutMinutes } = fields;
  return {
    value: {
      command, model, env: { ...env }, extract, organize, maxProjects, maxTranscriptBytes, maxTurns,
      maxBudgetUsd, timeoutMinutes,
    },
    problem: null,
  };
}

// The configuration file: AGENT_MEMORY_CONFIG, or ~/.config/agent-memory/config.json.
export function configPath(env = process.env) {
  return env.AGENT_MEMORY_CONFIG || join(env.HOME, '.config/agent-memory/config.json');
}

// Returns the validated config, or null when the feature is not enabled or the file is unusable.
export function loadConfig(env = process.env) {
  try {
    const home = env.HOME;
    const file = configPath(env);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object' || raw.enabled !== true) return null;
    if (typeof raw.host !== 'string' || !HOST_RE.test(raw.host)) return null;
    if (typeof raw.repoDir !== 'string' || !isAbsolute(raw.repoDir)) return null;
    const stateDir = raw.stateDir ?? join(home, '.local/state/agent-memory');
    const claudeDir = raw.claudeDir ?? join(home, '.claude');
    if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) return null;
    if (typeof claudeDir !== 'string' || !isAbsolute(claudeDir)) return null;
    const repoUrl = typeof raw.repoUrl === 'string' && raw.repoUrl ? raw.repoUrl : null;
    const stale = raw.staleAfterSeconds ?? 600;
    if (!Number.isFinite(stale) || stale <= 0) return null;
    const consolidate = parseConsolidate(raw.consolidate);
    return {
      host: raw.host, repoDir: raw.repoDir, repoUrl, stateDir, claudeDir, staleAfterSeconds: stale,
      consolidate: consolidate.value, consolidateProblem: consolidate.problem,
    };
  } catch {
    return null;
  }
}
