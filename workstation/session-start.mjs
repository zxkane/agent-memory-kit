// SessionStart hook driver: `session-start.mjs [claude|codex|kiro]`.
// Claude Code (default): links the session's memory folder into the notes clone
// and prints a JSON object with the shared-memory context. Codex and Kiro: print
// the context as plain text and create no link. Best effort: any error exits 0
// silently after one line in hook-errors.log.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { buildSessionContext, buildToolContext, logHookError } from './lib/context.mjs';
import { bindProject } from './lib/identity.mjs';
import { ensureLink } from './lib/link.mjs';
import { memoryLinkPath, projectName, repoIdentity, repoRoot } from './lib/project.mjs';
import { readStatus } from './lib/sync-engine.mjs';

const TOOLS = ['claude', 'codex', 'kiro'];

// True when linkPath is a symbolic link that resolves to dir.
function linksTo(linkPath, dir) {
  try {
    return lstatSync(linkPath).isSymbolicLink() && realpathSync(linkPath) === realpathSync(dir);
  } catch {
    return false;
  }
}

const cwdOf = (input) => (typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd());

function claudeContext(config, input) {
  const cwd = cwdOf(input);
  const repoOk = existsSync(join(config.repoDir, '.git'));
  const root = repoRoot(cwd);
  const project = root ? projectName(root) : null;
  let identity;
  let linkSkipped = null;
  if (repoOk && project) {
    const linkPath = memoryLinkPath(config.claudeDir, root);
    const targetDir = join(config.repoDir, 'projects', project);
    const bound = bindProject(targetDir, repoIdentity(root));
    if (bound.ok) {
      const linked = ensureLink({ linkPath, targetDir, host: config.host });
      if (linked.action === 'skipped') linkSkipped = linked.reason;
    } else if (bound.reason === 'no-identity') {
      identity = { reason: bound.reason, expected: null, linked: false };
    } else if (bound.expected !== null) {
      // A refusal without a recorded identity has nothing to report; the hook
      // still neither links nor adopts.
      identity = { reason: bound.reason, expected: bound.expected, linked: linksTo(linkPath, targetDir) };
    }
  }
  const additionalContext = buildSessionContext({
    config, status: readStatus(config), project, repoOk, identity, unusableName: root !== null && project === null, linkSkipped,
  });
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })}\n`;
}

// Same resolution as the Claude path, without the link step.
function toolContext(config, input) {
  const repoOk = existsSync(join(config.repoDir, '.git'));
  const root = repoRoot(cwdOf(input));
  const name = root ? projectName(root) : null;
  let project = null;
  let reason = null;
  let expected = null;
  if (root === null) {
    reason = 'not-a-repository';
  } else if (name === null) {
    reason = 'unusable-name';
  } else if (repoOk) {
    const bound = bindProject(join(config.repoDir, 'projects', name), repoIdentity(root));
    if (bound.ok) {
      project = name;
    } else if (bound.reason === 'no-identity') {
      reason = 'no-identity';
    } else {
      reason = 'mismatch';
      expected = bound.expected ?? null;
    }
  }
  return buildToolContext({ config, status: readStatus(config), project, repoOk, reason, expected });
}

// Parsed stdin JSON, or undefined when stdin is a terminal (never waited for), missing,
// empty or not JSON.
function readInput() {
  try {
    if (process.stdin.isTTY) return undefined;
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return undefined;
  }
}

const config = loadConfig();
if (config) {
  try {
    const tool = process.argv[2] ?? 'claude';
    if (!TOOLS.includes(tool)) throw new Error('unknown tool');
    const input = readInput();
    if (tool === 'claude') {
      if (input === undefined) throw new Error('hook input is not valid JSON');
      process.stdout.write(claudeContext(config, input));
    } else {
      process.stdout.write(toolContext(config, input));
    }
  } catch (err) {
    logHookError(config.stateDir, 'session-start', err?.message ?? err);
  }
}
