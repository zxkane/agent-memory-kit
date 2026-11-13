// Claude Code SessionStart hook: links the session's memory folder into the
// notes clone and prints the shared-memory context. Best effort: any error
// exits 0 silently after one line in hook-errors.log.
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { buildSessionContext, logHookError } from './lib/context.mjs';
import { bindProject } from './lib/identity.mjs';
import { ensureLink } from './lib/link.mjs';
import { memoryLinkPath, projectName, repoIdentity, repoRoot } from './lib/project.mjs';
import { readStatus } from './lib/sync-engine.mjs';

// True when linkPath is a symbolic link that resolves to dir.
function linksTo(linkPath, dir) {
  try {
    return lstatSync(linkPath).isSymbolicLink() && realpathSync(linkPath) === realpathSync(dir);
  } catch {
    return false;
  }
}

const config = loadConfig();
if (config) {
  try {
    let input;
    try {
      input = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
      throw new Error('hook input is not valid JSON');
    }
    const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
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
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })}\n`);
  } catch (err) {
    logHookError(config.stateDir, 'session-start', err?.message ?? err);
  }
}
