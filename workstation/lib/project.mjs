import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// Claude Code's project folder name: every non-alphanumeric character becomes '-'.
export function sanitizeSlug(absPath) {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

// Main repository root for cwd (a linked worktree resolves to its main repository), or null.
// Always the physical path, whatever path the session used. Works with Git 2.30, which has
// no `--path-format`: a relative common directory is relative to cwd.
export function repoRoot(cwd) {
  try {
    const common = realpathSync(resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir'])));
    if (basename(common) === '.git') return dirname(common);
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    return top ? realpathSync(top) : null;
  } catch {
    return null;
  }
}

export function projectName(root) {
  const name = basename(root);
  return NAME_RE.test(name) ? name : null;
}

export function memoryLinkPath(claudeDir, root) {
  return join(claudeDir, 'projects', sanitizeSlug(root), 'memory');
}

// Reduces a remote URL to `host/path`: no scheme, user, password or port, host
// in lower case, no trailing `.git` or `/`. Returns null for anything that does
// not name a remote host (local paths, file URLs, Windows drive paths).
function normalizeRemote(url) {
  let host;
  let path;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(url);
  if (scheme) {
    if (!['ssh', 'git', 'http', 'https'].includes(scheme[1].toLowerCase())) return null;
    const slash = scheme[2].indexOf('/');
    if (slash < 0) return null;
    host = scheme[2].slice(0, slash).replace(/^.*@/, '').replace(/:\d*$/, '');
    path = scheme[2].slice(slash + 1);
  } else {
    const scp = /^([^/\\\s]+@)?([^:/\\\s]+):(.+)$/.exec(url);
    if (!scp) return null;
    if (!scp[1] && scp[2].length === 1) return null; // a Windows drive letter, not a host
    host = scp[2];
    path = scp[3];
  }
  path = path.replace(/\/+$/, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  host = host.toLowerCase();
  if (!host || !path) return null;
  // A credential that contains '/', ':' or '@' defeats the splitting above.
  // When anything credential-shaped is left, refuse rather than record it.
  const identity = `${host}/${path}`;
  return /[@:]/.test(identity) ? null : identity;
}

// Identity of the repository: its normalized `origin` URL, or null. Never throws
// and never returns or logs credentials.
export function repoIdentity(root) {
  try {
    const url = git(root, ['config', '--get', 'remote.origin.url']);
    return url ? normalizeRemote(url) : null;
  } catch {
    return null;
  }
}
