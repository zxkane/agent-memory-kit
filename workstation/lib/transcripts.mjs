// Finds a project's conversation transcripts and builds a bounded text digest of them. Each tool
// has a reader of its own with one result shape, { interactive, wroteMemory, firstAt, lastAt,
// turns }: Claude Code (the conversation files of the folders linked to the project) and Codex (the
// session files whose directory lies in the project's repository).
import { closeSync, createReadStream, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { PROJECT_MARKER } from './identity.mjs';
import { normalizeRemote, projectIdentity, projectName, repoIdentity, repoRoot } from './project.mjs';
import { scanText } from './secret-scan.mjs';

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const ISO_RE = /^\d{4}-\d\d-\d\dT[\d:.]+Z?$/;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
// The memory API's write tool, as a gateway (`<target>___memory_write`) or a client
// (`mcp__<server>__<target>___memory_write`) names it.
const MEMORY_WRITE_RE = /(?:^|__)memory_write$/;
const PEM_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END_RE = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMemoryWrite = (name) => typeof name === 'string' && MEMORY_WRITE_RE.test(name);
const timeOf = (value) => (typeof value === 'string' && ISO_RE.test(value) ? value : null);

// The digest names the tool of each session.
const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex' };

// project name -> the session folders (<claudeDir>/projects/<slug>) whose `memory` entry is a
// symbolic link into <repoDir>/projects/<project>.
export function projectSessionDirs(config) {
  const result = new Map();
  let base;
  let slugs;
  try {
    base = realpathSync(join(config.repoDir, 'projects'));
    slugs = readdirSync(join(config.claudeDir, 'projects'), { withFileTypes: true });
  } catch {
    return result;
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const dir = join(config.claudeDir, 'projects', slug.name);
    const memory = join(dir, 'memory');
    try {
      if (!lstatSync(memory).isSymbolicLink()) continue;
      const target = realpathSync(memory);
      if (dirname(target) !== base) continue;
      const project = basename(target);
      if (!result.has(project)) result.set(project, []);
      result.get(project).push(dir);
    } catch {
      // Dangling link or unreadable entry: ignored.
    }
  }
  return result;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
}

// A file write into memory (the linked memory folder or the clone), or a call of the memory API's
// write tool.
function writesMemory(content, repoDir) {
  if (!Array.isArray(content)) return false;
  return content.some((b) => {
    if (!b || b.type !== 'tool_use') return false;
    if (isMemoryWrite(b.name)) return true;
    if (!WRITE_TOOLS.has(b.name)) return false;
    const path = b.input?.file_path;
    return typeof path === 'string' && (path.includes('/memory/') || path.startsWith(`${repoDir}/`));
  });
}

// Streams one Claude Code transcript file (JSON Lines) and keeps what the person and the agent said.
// `parse` is a seam for tests that count how many lines are parsed.
export async function readClaudeSession(file, repoDir, parse = JSON.parse) {
  const out = { interactive: false, wroteMemory: false, firstAt: null, lastAt: null, turns: [] };
  let typed = false;
  let anyPromptSource = false;
  let records = 0;
  let cliRecords = 0;
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let rec;
    try {
      rec = parse(line);
    } catch {
      continue;
    }
    if (rec === null || typeof rec !== 'object' || (rec.type !== 'user' && rec.type !== 'assistant')) continue;
    const at = typeof rec.timestamp === 'string' && ISO_RE.test(rec.timestamp) ? rec.timestamp : null;
    if (at) {
      if (out.firstAt === null || at < out.firstAt) out.firstAt = at;
      if (out.lastAt === null || at > out.lastAt) out.lastAt = at;
    }
    records++;
    if (rec.entrypoint === 'cli') cliRecords++;
    const content = rec.message?.content;
    let text;
    if (rec.type === 'user') {
      const hasSource = rec.promptSource !== undefined;
      if (hasSource) anyPromptSource = true;
      if (rec.promptSource === 'typed') typed = true;
      if (Array.isArray(content) && content.some((b) => b && b.type === 'tool_result')) continue;
      if (hasSource && rec.promptSource !== 'typed') continue;
      text = textOf(content).replace(REMINDER_RE, '').trim();
    } else {
      if (writesMemory(content, repoDir)) out.wroteMemory = true;
      text = textOf(content).trim();
    }
    if (text) out.turns.push({ role: rec.type === 'user' ? 'user' : 'agent', at, text });
  }
  out.interactive = anyPromptSource ? typed : records > 0 && cliRecords > records / 2;
  return out;
}

// ---- Codex ----
// Codex's session format is not a documented interface, so every field is checked before use and
// a record of another shape is skipped. Each file begins with a session_meta record (the session's
// directory and its source: `cli` or `vscode` for a session a person types in, `exec` for an
// automated run, `{ subagent: ... }` for a sub-agent thread). What the person typed and what the
// agent said are event records: `user_message` / `agent_message` in older versions, completed
// `UserMessage` / `AgentMessage` items in newer ones. The response items repeat the conversation
// together with the context Codex adds to it (instructions, environment), so they are read only for
// a role that has no event record at all.

// A line is parsed only when it can hold the session record, a message or a memory write.
const CODEX_TOKENS = [
  '"type":"session_meta"', '"type":"user_message"', '"type":"agent_message"', '"type":"UserMessage"',
  '"type":"AgentMessage"', '"type":"message"', '"type":"FileChange"', '"type":"patch_apply_begin"',
  '"type":"patch_apply_end"', '*** Begin Patch', 'memory_write',
];
const PATCH_PATH_RE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;
// Text that Codex itself puts into a user message: a tagged block or the AGENTS.md instructions.
const CODEX_CONTEXT_RE = /^\s*(?:<[A-Za-z_][\w-]*[\s>]|# AGENTS\.md instructions)/;
// A context block that the Codex app puts in front of what the person typed, such as
// `<in-app-browser-context>…</in-app-browser-context>`.
const LEADING_CONTEXT_RE = /^\s*<([a-z][\w-]*context)(?:\s[^>]*)?>[\s\S]*?<\/\1>/;
const withoutContext = (text) => {
  let rest = text;
  for (let m = LEADING_CONTEXT_RE.exec(rest); m; m = LEADING_CONTEXT_RE.exec(rest)) rest = rest.slice(m[0].length);
  return rest;
};
const INTERACTIVE_SOURCES = new Set(['cli', 'vscode']);

const blockTexts = (content, type) => (Array.isArray(content)
  ? content.filter((b) => isObject(b) && b.type === type && typeof b.text === 'string').map((b) => b.text) : []);

// The paths of an apply_patch text: the files it adds, updates, deletes or moves to.
const patchPaths = (text) => (typeof text === 'string' ? [...text.matchAll(PATCH_PATH_RE)].map((m) => m[1].trim()) : []);

// Every string in the JSON arguments of a tool call, one level into arrays and objects.
function argumentStrings(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const values = isObject(value) ? Object.values(value) : Array.isArray(value) ? value : [value];
  return values.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => typeof v === 'string');
}

// The file paths of a `changes` map: its keys, and where an update moves a file to.
function changePaths(changes) {
  if (!isObject(changes)) return [];
  return Object.entries(changes).flatMap(([path, change]) => {
    const moved = isObject(change) ? (change.move_path ?? change.update?.move_path) : null;
    return typeof moved === 'string' ? [path, moved] : [path];
  });
}

// Reads one Codex session file. Same result shape as readClaudeSession; `parse` is the same seam.
export async function readCodexSession(file, repoDir, parse = JSON.parse) {
  const out = { interactive: false, wroteMemory: false, firstAt: null, lastAt: null, turns: [] };
  let meta = null;
  // Where a forked thread's own history begins; the records before it are its parent's.
  let ownFrom = null;
  const found = [];
  const say = (role, from, at, texts) => {
    const text = texts.join('\n').trim();
    if (text) found.push({ role, from, at, text });
  };
  const inClone = (path) => {
    if (typeof path !== 'string' || path === '' || CONTROL_RE.test(path)) return false;
    const base = typeof meta?.cwd === 'string' && isAbsolute(meta.cwd) ? meta.cwd : '/';
    return resolve(base, path).startsWith(`${repoDir}/`);
  };
  const wrote = (paths) => {
    if (paths.some(inClone)) out.wroteMemory = true;
  };
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!CODEX_TOKENS.some((token) => line.includes(token))) continue;
    let rec;
    try {
      rec = parse(line);
    } catch {
      continue;
    }
    if (!isObject(rec) || !isObject(rec.payload)) continue;
    const p = rec.payload;
    if (rec.type === 'session_meta') {
      // Only the session's own record counts; a forked thread carries its parent's after it.
      if (meta === null) {
        meta = p;
        if (Number.isSafeInteger(p.subagent_history_start_ordinal) && p.subagent_history_start_ordinal >= 0) {
          ownFrom = p.subagent_history_start_ordinal;
        }
      }
      continue;
    }
    if (ownFrom !== null && Number.isSafeInteger(rec.ordinal) && rec.ordinal < ownFrom) continue;
    const at = timeOf(rec.timestamp);
    if (rec.type === 'event_msg') {
      const item = isObject(p.item) ? p.item : {};
      if (p.type === 'user_message' && typeof p.message === 'string' && (p.kind === undefined || p.kind === 'plain')) {
        say('user', 'event', at, [p.message]);
      } else if (p.type === 'agent_message' && typeof p.message === 'string') {
        say('agent', 'event', at, [p.message]);
      } else if (p.type === 'item_completed' && item.type === 'UserMessage') {
        say('user', 'event', at, blockTexts(item.content, 'text').map(withoutContext));
      } else if (p.type === 'item_completed' && item.type === 'AgentMessage') {
        say('agent', 'event', at, blockTexts(item.content, 'text'));
      } else if (p.type === 'item_completed' && item.type === 'FileChange') {
        wrote(changePaths(item.changes));
      } else if (p.type === 'item_completed' && item.type === 'McpToolCall') {
        if (isMemoryWrite(item.tool)) out.wroteMemory = true;
      } else if (p.type === 'patch_apply_begin' || p.type === 'patch_apply_end') {
        wrote(changePaths(p.changes));
      } else if ((p.type === 'mcp_tool_call_begin' || p.type === 'mcp_tool_call_end') && isMemoryWrite(p.invocation?.tool)) {
        out.wroteMemory = true;
      }
    } else if (rec.type === 'response_item') {
      if (p.type === 'message' && p.role === 'user') {
        say('user', 'item', at, blockTexts(p.content, 'input_text').filter((text) => !CODEX_CONTEXT_RE.test(text)));
      } else if (p.type === 'message' && p.role === 'assistant') {
        say('agent', 'item', at, blockTexts(p.content, 'output_text'));
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        if (isMemoryWrite(p.name)) out.wroteMemory = true;
        const texts = p.type === 'custom_tool_call' ? [p.input] : typeof p.arguments === 'string' ? argumentStrings(p.arguments) : [];
        wrote(texts.flatMap(patchPaths));
      }
    }
  }
  out.interactive = meta !== null && INTERACTIVE_SOURCES.has(meta.source);
  const source = (role) => (found.some((t) => t.role === role && t.from === 'event') ? 'event' : 'item');
  const from = { user: source('user'), agent: source('agent') };
  // The user turns of an automated run or a sub-agent thread are prompts that a program or another
  // agent wrote, not what the person typed: like an SDK prompt of Claude Code, they are left out.
  out.turns = found.filter((t) => t.from === from[t.role] && (out.interactive || t.role === 'agent'))
    .map(({ role, at, text }) => ({ role, at, text }));
  const times = out.turns.map((t) => t.at).filter((t) => t !== null).sort();
  out.firstAt = times[0] ?? null;
  out.lastAt = times.at(-1) ?? null;
  return out;
}

const READERS = { claude: readClaudeSession, codex: readCodexSession };

// Replaces every line the secret scanner flags, and a private key block through its END line.
function redact(text) {
  let inKey = false;
  return text.split('\n').map((line) => {
    if (inKey) {
      if (PEM_END_RE.test(line)) inKey = false;
      return '[redacted]';
    }
    if (PEM_BEGIN_RE.test(line)) {
      inKey = !PEM_END_RE.test(line);
      return '[redacted]';
    }
    return scanText(line).length > 0 ? '[redacted]' : line;
  }).join('\n');
}

function cut(text, limit) {
  if (text.length <= limit) return text;
  let head = text.slice(0, limit);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}[cut]`;
}

const bytes = (s) => Buffer.byteLength(s, 'utf8');

// A short name for a session in the digest: the start of a Claude Code file name (its session ID),
// the end of a Codex one (`rollout-<time>-<ID>.jsonl`, whose ID ends in random digits).
function sessionLabel(tool, file) {
  const name = basename(file, '.jsonl');
  return (tool === 'codex' ? name.slice(-8) : name.slice(0, 8)).replace(/[\u0000-\u001f\u007f]/g, '?');
}

function sessionBlocks({ tool, file }, session, perTurnChars) {
  const header = `=== ${TOOL_NAMES[tool]} session ${sessionLabel(tool, file)}, ${session.firstAt ?? 'unknown'} to ${session.lastAt ?? 'unknown'} ===\n`;
  const turns = session.turns.map((turn) => ({
    label: `${turn.role === 'user' ? 'USER' : 'AGENT'}${turn.at ? ` (${turn.at})` : ''}:\n`,
    body: cut(redact(turn.text), perTurnChars),
  }));
  return { header, turns };
}

// The longest start of `text` that fits `limit` bytes, never splitting a character.
function fitBytes(text, limit) {
  let out = '';
  let used = 0;
  for (const ch of text) {
    used += bytes(ch);
    if (used > limit) break;
    out += ch;
  }
  return out;
}

// The turns of a session that lie after the window start `since` (ms): a turn whose time is known
// and is at or before it was digested by an earlier run. A turn without a time is kept. The
// session's first and last times are those of the turns kept.
function inWindow(session, since) {
  const turns = session.turns.filter((turn) => turn.at === null || !(Date.parse(turn.at) <= since));
  const times = turns.map((turn) => turn.at).filter((at) => at !== null).sort();
  return { ...session, turns, firstAt: times[0] ?? null, lastAt: times.at(-1) ?? null };
}

// A bounded digest of the sessions of every tool together, newest session first. `files` lists
// `{ tool, file }` entries, `tool` being `claude` or `codex`. With `since`, only turns after it are
// used, and a session with none left is not used. When the newest session alone is too large,
// its newest turns are kept (in their order); when not even its newest turn fits, that turn is
// cut. `truncated` says that anything was cut or left out; `sessionsLeftOut` counts the
// qualifying sessions of which nothing reached the digest.
export async function buildDigest({ files, repoDir, maxBytes, perTurnChars = 2000, since = null }) {
  const sessions = [];
  for (const entry of files) {
    const read = READERS[entry.tool];
    if (!read) continue;
    let session;
    try {
      session = await read(entry.file, repoDir);
    } catch {
      continue; // Missing, unreadable or not a file: the other sessions are still used.
    }
    if (!session.interactive && !session.wroteMemory) continue;
    if (since !== null) session = inWindow(session, since);
    if (session.turns.length > 0) sessions.push({ entry, session });
  }
  sessions.sort((a, b) => (b.session.lastAt ?? '').localeCompare(a.session.lastAt ?? ''));
  let text = '';
  let used = 0;
  let count = 0;
  let truncated = false;
  for (const { entry, session } of sessions) {
    const { header, turns } = sessionBlocks(entry, session, perTurnChars);
    const blocks = turns.map((t) => `${t.label}${t.body}\n\n`);
    const whole = header + blocks.join('');
    if (used + bytes(whole) <= maxBytes) {
      text += whole;
      used += bytes(whole);
      count++;
      continue;
    }
    truncated = true;
    if (count === 0) {
      // The newest session alone is too large. Keep its newest turns that fit whole. When not
      // even the newest turn fits, cut that turn further so the header and one turn fit. Only
      // when the header line alone does not fit is the digest empty (truncated, no sessions).
      const kept = [];
      let size = bytes(header);
      for (let i = blocks.length - 1; i >= 0; i--) {
        if (size + bytes(blocks[i]) > maxBytes) break;
        kept.unshift(blocks[i]);
        size += bytes(blocks[i]);
      }
      if (kept.length === 0) {
        const last = turns.at(-1);
        const room = maxBytes - bytes(header) - bytes(last.label) - bytes('[cut]\n\n');
        if (room > 0) kept.push(`${last.label}${fitBytes(last.body, room)}[cut]\n\n`);
      }
      if (kept.length > 0) {
        text = header + kept.join('');
        count = 1;
      }
    }
    break;
  }
  return { text, sessions: count, truncated, sessionsLeftOut: sessions.length - count };
}

// Top-level *.jsonl files in the Claude Code folders that changed after sinceMs.
export function sessionFilesSince(dirs, sinceMs) {
  const files = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = join(dir, e.name);
      try {
        if (statSync(file).mtimeMs > sinceMs) files.push(file);
      } catch {
        // Vanished between listing and stat.
      }
    }
  }
  return files.sort();
}

// The files of `files` that changed after sinceMs; a file that is gone is left out.
export function filesChangedSince(files, sinceMs) {
  return files.filter((file) => {
    try {
      return statSync(file).mtimeMs > sinceMs;
    } catch {
      return false;
    }
  });
}

// ---- Which project a Codex session belongs to ----

const DATE_FOLDER_RES = [/^\d{4}$/, /^\d\d$/, /^\d\d$/];
const ROLLOUT_RE = /^rollout-.+\.jsonl$/;
const META_MAX_BYTES = 1024 * 1024;

// Codex's session files, <codexDir>/sessions/YYYY/MM/DD/rollout-*.jsonl, that changed after sinceMs.
// Regular files only: a link (to a file or a folder) is not followed.
export function codexSessionFiles(codexDir, sinceMs) {
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (depth < DATE_FOLDER_RES.length) {
        if (e.isDirectory() && DATE_FOLDER_RES[depth].test(e.name)) walk(path, depth + 1);
      } else if (e.isFile() && ROLLOUT_RE.test(e.name)) {
        try {
          if (statSync(path).mtimeMs > sinceMs) files.push(path);
        } catch {
          // Vanished between listing and stat.
        }
      }
    }
  };
  walk(join(codexDir, 'sessions'), 0);
  return files.sort();
}

// The first line of a file, or null when it is longer than `limit` bytes or cannot be read.
function firstLine(file, limit) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const chunks = [];
    let size = 0;
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      const end = buf.subarray(0, n).indexOf(0x0a);
      chunks.push(Buffer.from(buf.subarray(0, end < 0 ? n : end)));
      size += end < 0 ? n : end;
      if (size > limit) return null;
      if (end >= 0) break;
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The directory and the recorded repository of a Codex session, from its first record.
function codexMeta(file) {
  const line = firstLine(file, META_MAX_BYTES);
  if (line === null) return null;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  const p = isObject(rec) && rec.type === 'session_meta' && isObject(rec.payload) ? rec.payload : null;
  if (p === null || typeof p.cwd !== 'string' || !isAbsolute(p.cwd) || CONTROL_RE.test(p.cwd)) return null;
  const url = isObject(p.git) && typeof p.git.repository_url === 'string' ? p.git.repository_url : null;
  return { cwd: p.cwd, url };
}

// The root of the repository a session ran in, or null. A directory that is gone (a removed
// worktree, for example) counts as in the repository around its nearest remaining parent folder,
// but only when that repository's `origin` is the repository the session recorded.
function sessionRepository({ cwd, url }) {
  if (existsSync(cwd)) return repoRoot(cwd);
  const recorded = url === null ? null : normalizeRemote(url);
  if (recorded === null) return null;
  let dir = dirname(cwd);
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  const root = repoRoot(dir);
  return root !== null && repoIdentity(root) === recorded ? root : null;
}

// The project folder that a repository binds, by the rules of linking: its directory name, and
// a `.project` that holds its identity (or the machine-bound identity it replaces); else null.
function boundProject(config, root, wanted) {
  const name = projectName(root);
  if (name === null || !wanted.has(name)) return null;
  let recorded;
  try {
    recorded = readFileSync(join(config.repoDir, 'projects', name, PROJECT_MARKER), 'utf8').trim();
  } catch {
    return null;
  }
  const { identity, replaces } = projectIdentity(root, config.host);
  return recorded !== '' && (recorded === identity || (replaces !== null && recorded === replaces)) ? name : null;
}

// project name -> the Codex session files changed after sinceMs whose directory lies in the
// repository bound to that project folder. Only the names in `projects` are considered.
export function codexProjectSessions(config, { sinceMs, projects }) {
  const result = new Map();
  const wanted = new Set(projects);
  if (wanted.size === 0 || typeof config.codexDir !== 'string') return result;
  const repositories = new Map();
  const owners = new Map();
  for (const file of codexSessionFiles(config.codexDir, sinceMs)) {
    const meta = codexMeta(file);
    if (meta === null) continue;
    const key = `${meta.cwd}\n${meta.url ?? ''}`;
    if (!repositories.has(key)) repositories.set(key, sessionRepository(meta));
    const root = repositories.get(key);
    if (root === null) continue;
    if (!owners.has(root)) owners.set(root, boundProject(config, root, wanted));
    const project = owners.get(root);
    if (project === null) continue;
    if (!result.has(project)) result.set(project, []);
    result.get(project).push(file);
  }
  return result;
}
