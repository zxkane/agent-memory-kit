// Finds a project's conversation transcripts and builds a bounded text digest of them.
import { createReadStream, readdirSync, realpathSync, lstatSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { scanText } from './secret-scan.mjs';

const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const ISO_RE = /^\d{4}-\d\d-\d\dT[\d:.]+Z?$/;
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const PEM_BEGIN_RE = /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END_RE = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/;

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

function writesMemory(content, repoDir) {
  if (!Array.isArray(content)) return false;
  return content.some((b) => {
    if (!b || b.type !== 'tool_use' || !WRITE_TOOLS.has(b.name)) return false;
    const path = b.input?.file_path;
    return typeof path === 'string' && (path.includes('/memory/') || path.startsWith(`${repoDir}/`));
  });
}

// Streams one transcript file (JSON Lines) and keeps what the person and the agent said.
// `parse` is a seam for tests that count how many lines are parsed.
export async function readSession(file, repoDir, parse = JSON.parse) {
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

function sessionBlocks(file, session, perTurnChars) {
  const name = basename(file).slice(0, 8).replace(/[\u0000-\u001f\u007f]/g, '?');
  const header = `=== session ${name}, ${session.firstAt ?? 'unknown'} to ${session.lastAt ?? 'unknown'} ===\n`;
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

// A bounded digest of the sessions, newest session first. With `since`, only turns after it are
// used, and a session with none left is not used. When the newest session alone is too large,
// its newest turns are kept (in their order); when not even its newest turn fits, that turn is
// cut. `truncated` says that anything was cut or left out; `sessionsLeftOut` counts the
// qualifying sessions of which nothing reached the digest.
export async function buildDigest({ files, repoDir, maxBytes, perTurnChars = 2000, since = null }) {
  const sessions = [];
  for (const file of files) {
    let session;
    try {
      session = await readSession(file, repoDir);
    } catch {
      continue; // Missing, unreadable or not a file: the other sessions are still used.
    }
    if (!session.interactive && !session.wroteMemory) continue;
    if (since !== null) session = inWindow(session, since);
    if (session.turns.length > 0) sessions.push({ file, session });
  }
  sessions.sort((a, b) => (b.session.lastAt ?? '').localeCompare(a.session.lastAt ?? ''));
  let text = '';
  let used = 0;
  let count = 0;
  let truncated = false;
  for (const { file, session } of sessions) {
    const { header, turns } = sessionBlocks(file, session, perTurnChars);
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

// Top-level *.jsonl files in the folders that changed after sinceMs.
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
