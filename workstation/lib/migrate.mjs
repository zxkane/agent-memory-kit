// One-time move of Claude Code's existing per-repository memory folders into the
// notes clone. Planning only reads; applying goes through ensureLink so that the
// copy, the backup and the link follow the same locked sequence as everywhere else.
import {
  closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, parse } from 'node:path';
import { PROJECT_MARKER, bindProject } from './identity.mjs';
import { ensureLink, hasNestedEntries, mergeIndex } from './link.mjs';
import { projectName, repoIdentity, repoRoot, sanitizeSlug } from './project.mjs';
import { scanText } from './secret-scan.mjs';

const INDEX = 'MEMORY.md';
const SESSION_BYTES = 256 * 1024;
const SESSION_LINES = 50;

function readIfFile(path) {
  try {
    return readFileSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function dirNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

// Regular files that sit directly in dir (what adoptDir copies), sorted.
function fileNames(dir) {
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort();
}

function newestSession(dir) {
  let best = null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const mtime = lstatSync(join(dir, e.name)).mtimeMs;
    if (best === null || mtime > best.mtime || (mtime === best.mtime && e.name > best.name)) best = { name: e.name, mtime };
  }
  return best && join(dir, best.name);
}

// The first `cwd` value within the first lines of a session file, or null.
function firstCwd(file) {
  let fd;
  let text;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(SESSION_BYTES);
    text = buf.toString('utf8', 0, readSync(fd, buf, 0, SESSION_BYTES, 0));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  for (const line of text.split('\n').slice(0, SESSION_LINES)) {
    try {
      const value = JSON.parse(line)?.cwd;
      if (typeof value === 'string' && value !== '') return value;
    } catch {
      // not a JSON line: keep looking
    }
  }
  return null;
}

// Maps the folder name Claude Code would use for a repository root to that root.
// A folder name claimed by two different roots is dropped: it cannot tell which
// repository the notes belong to.
export function buildRootMap(claudeDir) {
  const map = new Map();
  const ambiguous = new Set();
  const projectsDir = join(claudeDir, 'projects');
  for (const name of dirNames(projectsDir)) {
    let cwd = null;
    try {
      const session = newestSession(join(projectsDir, name));
      cwd = session && firstCwd(session);
    } catch {
      continue;
    }
    const root = cwd && repoRoot(cwd);
    if (!root) continue;
    const key = sanitizeSlug(root);
    if (ambiguous.has(key)) continue;
    const prior = map.get(key);
    if (prior !== undefined && prior !== root) {
      map.delete(key);
      ambiguous.add(key);
      continue;
    }
    map.set(key, root);
  }
  return map;
}

function scanFiles(dir, names) {
  const findings = [];
  for (const file of names) {
    for (const { id, line } of scanText(readFileSync(join(dir, file), 'utf8'))) findings.push({ file, id, line });
  }
  return findings;
}

// The identity recorded in a project folder's marker, or null. Reads only.
function recordedIdentity(projectDir) {
  const text = readIfFile(join(projectDir, PROJECT_MARKER));
  return text === null ? null : text.toString('utf8').trim() || null;
}

export function planMigration(config) {
  const roots = buildRootMap(config.claudeDir);
  const projectsDir = join(config.claudeDir, 'projects');
  const claimed = new Map();
  const items = [];
  for (const slug of dirNames(projectsDir)) {
    const memoryDir = join(projectsDir, slug, 'memory');
    if (!lstatOrNull(memoryDir)?.isDirectory()) continue; // missing, or a link made earlier
    const names = fileNames(memoryDir);
    const root = roots.get(slug) ?? null;
    const project = root === null ? null : projectName(root);
    const item = {
      slug, memoryDir, files: names.length, root, project, action: 'skip', reason: null, findings: scanFiles(memoryDir, names),
    };
    items.push(item);
    // ensureLink does not adopt a folder that holds anything other than regular files.
    if (hasNestedEntries(memoryDir)) item.reason = 'nested-entries';
    else if (names.length === 0) item.reason = 'empty';
    else if (root === null) item.reason = 'no-repository';
    else if (project === null) item.reason = 'unsafe-project-name';
    else {
      const identity = repoIdentity(root);
      const recorded = recordedIdentity(join(config.repoDir, 'projects', project));
      if (identity === null) {
        item.reason = 'no-remote';
      } else if ((recorded !== null && recorded !== identity) || (claimed.has(project) && claimed.get(project) !== identity)) {
        item.reason = 'name-collision';
      } else {
        claimed.set(project, identity);
        item.action = 'adopt';
      }
    }
  }
  return items;
}

// True when the frontmatter holds `metadata:` with an indented `type: user`.
function isUserNote(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0]?.trimEnd() !== '---') return false;
  let inMetadata = false;
  for (const line of lines.slice(1)) {
    if (line.trimEnd() === '---') return false;
    if (/^metadata:[ \t]*$/.test(line)) inMetadata = true;
    else if (inMetadata && /^ {2}type:[ \t]*user[ \t]*$/.test(line)) return true;
    else if (inMetadata && line !== '' && !/^\s/.test(line)) inMetadata = false;
  }
  return false;
}

// Moves a file into globalDir keeping both versions on a name collision
// (<stem>.<host><ext>, then -2, -3, ...). Returns the name it now has there.
function placeInGlobal(from, name, globalDir, host) {
  const bytes = readFileSync(from);
  const { name: stem, ext } = parse(name);
  for (let n = 0; ; n += 1) {
    const candidate = n === 0 ? name : `${stem}.${host}${n === 1 ? '' : `-${n}`}${ext}`;
    const existing = readIfFile(join(globalDir, candidate));
    if (existing === null) {
      renameSync(from, join(globalDir, candidate));
      return candidate;
    }
    if (existing.equals(bytes)) {
      rmSync(from);
      return candidate;
    }
  }
}

function linesOf(text) {
  const parts = text.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

// Moves the notes of type `user` from a project folder to global/, with their index lines.
function moveUserNotes(projectDir, globalDir, host) {
  const names = fileNames(projectDir).filter(
    (n) => n.endsWith('.md') && n !== INDEX && isUserNote(readFileSync(join(projectDir, n), 'utf8')),
  );
  if (names.length === 0) return [];
  mkdirSync(globalDir, { recursive: true });
  const renames = new Map();
  for (const name of names) renames.set(name, placeInGlobal(join(projectDir, name), name, globalDir, host));

  const indexPath = join(projectDir, INDEX);
  const index = readIfFile(indexPath);
  if (index !== null) {
    const moved = [];
    const kept = [];
    for (const line of linesOf(index.toString('utf8'))) {
      const targets = [...line.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
      (targets.some((p) => renames.has(p)) ? moved : kept).push(line);
    }
    if (moved.length) {
      const globalIndex = join(globalDir, INDEX);
      const current = readIfFile(globalIndex);
      const merged = mergeIndex(current === null ? '' : current.toString('utf8'), moved.join('\n'), renames);
      writeFileSync(globalIndex, merged);
      writeFileSync(indexPath, kept.length ? `${kept.join('\n')}\n` : '');
    }
  }
  return [...renames.values()];
}

export function applyMigration(items, config, opts = {}) {
  const { now = new Date(), skipFlagged = false } = opts;
  const result = {
    adopted: 0, copied: 0, renamed: [], movedToGlobal: [], indexNotCopied: [], skipped: [], adoptedFolders: [],
  };

  // Scan again now: a file may have changed since the plan was made.
  const flagged = new Map();
  for (const item of items) {
    if (item.action !== 'adopt' || !lstatOrNull(item.memoryDir)?.isDirectory()) continue;
    const findings = scanFiles(item.memoryDir, fileNames(item.memoryDir));
    if (findings.length) flagged.set(item, new Set(findings.map((f) => f.file)));
  }
  if (flagged.size && !skipFlagged) throw new Error('flagged files present');

  for (const item of items) {
    const skip = (reason) => result.skipped.push({ slug: item.slug, reason });
    if (item.action !== 'adopt') {
      skip(item.reason);
      continue;
    }
    const st = lstatOrNull(item.memoryDir);
    if (st === null) {
      skip('missing');
      continue;
    }
    if (!st.isDirectory()) {
      skip('already-linked');
      continue;
    }
    if (item.root === null || item.project === null) {
      skip('no-repository');
      continue;
    }
    const targetDir = join(config.repoDir, 'projects', item.project);
    const bound = bindProject(targetDir, repoIdentity(item.root));
    if (!bound.ok) {
      skip(bound.reason === 'no-identity' ? 'no-remote' : 'name-collision');
      continue;
    }
    const skipFiles = flagged.get(item) ?? new Set();
    const linked = ensureLink({ linkPath: item.memoryDir, targetDir, host: config.host, now, skip: skipFiles });
    if (linked.action === 'skipped') {
      skip(linked.reason);
      continue;
    }
    if (linked.action !== 'adopted') continue;
    result.adopted += 1;
    result.copied += linked.copied;
    // File names only: the flagged files stay in the backup folder.
    result.adoptedFolders.push({
      slug: item.slug, project: item.project, backupDir: linked.backupDir, leftOut: [...skipFiles].sort(),
    });
    result.renamed.push(...linked.renamed.map((r) => `${item.project}/${r}`));
    if (skipFiles.has(INDEX)) result.indexNotCopied.push(item.slug);
    result.movedToGlobal.push(...moveUserNotes(targetDir, join(config.repoDir, 'global'), config.host));
  }
  return result;
}
