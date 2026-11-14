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

// The optional consolidation block. Any problem gives null: it never disables the rest of the config.
function parseConsolidate(block) {
  if (block === undefined || block === null || typeof block !== 'object' || Array.isArray(block)) return null;
  const { command, model } = block;
  if (typeof command !== 'string' || !isAbsolute(command) || CONTROL_RE.test(command)) return null;
  if (typeof model !== 'string' || !/^\S+$/.test(model)) return null;
  const env = block.env ?? {};
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return null;
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME_RE.test(k) || typeof v !== 'string' || CONTROL_RE.test(v)) return null;
  }
  const extract = calendar(block.extract);
  const organize = calendar(block.organize);
  const maxProjects = intIn(block.maxProjects, 5, 1, 50);
  const maxTranscriptBytes = intIn(block.maxTranscriptBytes, 200000, 10000, 2000000);
  const maxTurns = intIn(block.maxTurns, 200, 1, 1000);
  const timeoutMinutes = intIn(block.timeoutMinutes, 30, 1, 240);
  const budget = block.maxBudgetUsd ?? 5;
  const maxBudgetUsd = typeof budget === 'number' && budget > 0 && budget <= 100 ? budget : undefined;
  if ([extract, organize, maxProjects, maxTranscriptBytes, maxTurns, timeoutMinutes, maxBudgetUsd].includes(undefined)) {
    return null;
  }
  return {
    command, model, env: { ...env }, extract, organize, maxProjects, maxTranscriptBytes, maxTurns,
    maxBudgetUsd, timeoutMinutes,
  };
}

// Returns the validated config, or null when the feature is not enabled or the file is unusable.
export function loadConfig(env = process.env) {
  try {
    const home = env.HOME;
    const file = env.AGENT_MEMORY_CONFIG || join(home, '.config/agent-memory/config.json');
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
    return {
      host: raw.host, repoDir: raw.repoDir, repoUrl, stateDir, claudeDir, staleAfterSeconds: stale,
      consolidate: parseConsolidate(raw.consolidate),
    };
  } catch {
    return null;
  }
}
