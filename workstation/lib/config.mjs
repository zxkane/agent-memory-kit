import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const HOST_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

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
    return { host: raw.host, repoDir: raw.repoDir, repoUrl, stateDir, claudeDir, staleAfterSeconds: stale };
  } catch {
    return null;
  }
}
