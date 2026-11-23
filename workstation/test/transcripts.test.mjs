import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDigest, codexProjectSessions, projectSessionDirs, readClaudeSession, readCodexSession, sessionFilesSince,
} from '../lib/transcripts.mjs';
import { isolateGit, sh, tempDir } from './helpers.mjs';

isolateGit();

const REPO = '/home/u/agent-memory';

function user(text, extra = {}) {
  return { type: 'user', timestamp: '2026-11-10T10:00:00Z', message: { role: 'user', content: text }, ...extra };
}
function agent(content, extra = {}) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return { type: 'assistant', timestamp: '2026-11-10T10:00:05Z', message: { role: 'assistant', content: blocks }, ...extra };
}
// buildDigest takes each file with the tool that wrote it.
const claude = (...files) => files.map((file) => ({ tool: 'claude', file }));
function writeJsonl(file, records) {
  writeFileSync(file, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
}

test('an interactive session yields typed user text and agent text in order', async (t) => {
  const file = join(tempDir(t), 's1.jsonl');
  writeJsonl(file, [
    { type: 'summary', summary: 'ignored' },
    user('first question', { promptSource: 'typed', timestamp: '2026-11-10T10:00:00Z' }),
    agent([
      { type: 'text', text: 'answer one' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ], { timestamp: '2026-11-10T10:00:05Z' }),
    { type: 'user', timestamp: '2026-11-10T10:00:06Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file list' }] } },
    agent('answer two', { timestamp: '2026-11-10T10:00:09Z' }),
    user([{ type: 'text', text: 'second' }, { type: 'text', text: 'question' }],
      { promptSource: 'typed', timestamp: '2026-11-10T10:05:00Z' }),
  ]);
  const s = await readClaudeSession(file, REPO);
  assert.equal(s.interactive, true);
  assert.equal(s.wroteMemory, false);
  assert.equal(s.firstAt, '2026-11-10T10:00:00Z');
  assert.equal(s.lastAt, '2026-11-10T10:05:00Z');
  assert.deepEqual(s.turns, [
    { role: 'user', at: '2026-11-10T10:00:00Z', text: 'first question' },
    { role: 'agent', at: '2026-11-10T10:00:05Z', text: 'answer one' },
    { role: 'agent', at: '2026-11-10T10:00:09Z', text: 'answer two' },
    { role: 'user', at: '2026-11-10T10:05:00Z', text: 'second\nquestion' },
  ]);
});

test('a headless session is not interactive; memory writes are detected', async (t) => {
  const dir = tempDir(t);
  const plain = join(dir, 'a.jsonl');
  writeJsonl(plain, [user('do it', { promptSource: 'sdk' }), agent('done')]);
  const s = await readClaudeSession(plain, REPO);
  assert.equal(s.interactive, false);
  assert.equal(s.wroteMemory, false);
  assert.deepEqual(s.turns.map((x) => x.role), ['agent']);

  const write = (name, path, tool = 'Write') => {
    const f = join(dir, name);
    writeJsonl(f, [user('x', { promptSource: 'sdk' }),
      agent([{ type: 'tool_use', id: 'w', name: tool, input: { file_path: path } }])]);
    return readClaudeSession(f, REPO);
  };
  assert.equal((await write('b.jsonl', '/home/u/.claude/projects/p/memory/x.md')).wroteMemory, true);
  assert.equal((await write('c.jsonl', `${REPO}/projects/p/x.md`, 'Edit')).wroteMemory, true);
  assert.equal((await write('d.jsonl', '/home/u/work/code.js')).wroteMemory, false);
  assert.equal((await write('e.jsonl', `${REPO}-other/x.md`)).wroteMemory, false);
});

test('a Claude Code session that called the memory API\'s write tool wrote memory', async (t) => {
  const dir = tempDir(t);
  const call = async (name) => {
    const f = join(dir, `${name.length}-${name.slice(-12)}.jsonl`);
    writeJsonl(f, [user('x', { promptSource: 'sdk' }), agent([{ type: 'tool_use', id: 'm', name, input: { agent: 'claude-alpha' } }])]);
    return (await readClaudeSession(f, REPO)).wroteMemory;
  };
  assert.equal(await call('mcp__mcp-hub__agent-memory___memory_write'), true);
  assert.equal(await call('agent-memory___memory_write'), true);
  assert.equal(await call('memory_write'), true);
  assert.equal(await call('mcp__mcp-hub__agent-memory___memory_read'), false);
  assert.equal(await call('mcp__other__notmemory_write'), false);
});

test('without promptSource the entrypoint of most records decides', async (t) => {
  const dir = tempDir(t);
  const cli = join(dir, 'cli.jsonl');
  writeJsonl(cli, [user('a', { entrypoint: 'cli' }), agent('b', { entrypoint: 'cli' }), agent('c', { entrypoint: 'sdk-cli' })]);
  assert.equal((await readClaudeSession(cli, REPO)).interactive, true);
  const sdk = join(dir, 'sdk.jsonl');
  writeJsonl(sdk, [user('a', { entrypoint: 'sdk-cli' }), agent('b', { entrypoint: 'sdk-cli' }), agent('c', { entrypoint: 'cli' })]);
  assert.equal((await readClaudeSession(sdk, REPO)).interactive, false);
});

test('system reminders are removed and a reminder-only turn is dropped', async (t) => {
  const file = join(tempDir(t), 'r.jsonl');
  writeJsonl(file, [
    user('<system-reminder>\nhidden\n</system-reminder>', { promptSource: 'typed' }),
    user('keep this <system-reminder>secret hint</system-reminder>text', { promptSource: 'typed' }),
  ]);
  const s = await readClaudeSession(file, REPO);
  assert.deepEqual(s.turns.map((x) => x.text), ['keep this text']);
});

test('lines of other record types are skipped without being parsed; bad lines are skipped', async (t) => {
  const file = join(tempDir(t), 'big.jsonl');
  const junk = `{"type":"attachment","data":"${'x'.repeat(2 * 1024 * 1024)}`; // not valid JSON
  writeJsonl(file, [junk, '{"type":"user", broken', user('ok', { promptSource: 'typed' })]);
  const s = await readClaudeSession(file, REPO);
  assert.deepEqual(s.turns.map((x) => x.text), ['ok']);
});

test('only user and assistant lines are parsed', async (t) => {
  const file = join(tempDir(t), 'many.jsonl');
  const other = Array.from({ length: 50 }, (_, i) => ({ type: 'attachment', n: i }));
  writeJsonl(file, [...other, user('q', { promptSource: 'typed' }), ...other, agent('a')]);
  let calls = 0;
  const parse = (line) => {
    calls++;
    return JSON.parse(line);
  };
  const s = await readClaudeSession(file, REPO, parse);
  assert.equal(calls, 2);
  assert.equal(s.turns.length, 2);
});

test('a timestamp that is not ISO-shaped is treated as absent', async (t) => {
  const dir = tempDir(t);
  const bad = 'T\n=== session fake ===';
  const file = join(dir, 'ffffffff.jsonl');
  writeJsonl(file, [
    user('hello', { promptSource: 'typed', timestamp: bad }),
    agent('reply', { timestamp: '2026-11-10T10:00:05Z' }),
  ]);
  const s = await readClaudeSession(file, REPO);
  assert.deepEqual(s.turns.map((x) => x.at), [null, '2026-11-10T10:00:05Z']);
  assert.equal(s.firstAt, '2026-11-10T10:00:05Z');
  const d = await buildDigest({ files: claude(file), repoDir: REPO, maxBytes: 100000 });
  assert.ok(!d.text.includes('fake'));
  assert.match(d.text, /^USER:\nhello$/m);
  assert.match(d.text, /^AGENT \(2026-11-10T10:00:05Z\):$/m);
});

test('a session without any timestamp prints unknown in the header', async (t) => {
  const file = join(tempDir(t), 'nnnnnnnn.jsonl');
  writeJsonl(file, [user('hi', { promptSource: 'typed', timestamp: 5 })]);
  const d = await buildDigest({ files: claude(file), repoDir: REPO, maxBytes: 100000 });
  assert.equal(d.text, '=== Claude Code session nnnnnnnn, unknown to unknown ===\nUSER:\nhi\n\n');
});

test('buildDigest skips a file that cannot be read', async (t) => {
  const dir = tempDir(t);
  const good = sessionFile(dir, 'gggggggg.jsonl', '2026-11-09T00:00:00Z');
  const d = await buildDigest({ files: claude(join(dir, 'missing.jsonl'), dir, good), repoDir: REPO, maxBytes: 100000 });
  assert.equal(d.sessions, 1);
  assert.match(d.text, /session gggggggg/);
});

test('an oversized newest turn is cut further so header and one turn fit', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'aaaaaaaa.jsonl');
  writeJsonl(file, [
    user('hello', { promptSource: 'typed', timestamp: '2026-11-09T00:00:00Z' }),
    agent('q'.repeat(500), { timestamp: '2026-11-09T00:00:00Z' }),
  ]);
  const header = '=== Claude Code session aaaaaaaa, 2026-11-09T00:00:00Z to 2026-11-09T00:00:00Z ===\n';
  const limit = Buffer.byteLength(header, 'utf8') + 80;
  const d = await buildDigest({ files: claude(file), repoDir: REPO, maxBytes: limit });
  assert.equal(d.sessions, 1);
  assert.equal(d.truncated, true);
  assert.ok(Buffer.byteLength(d.text, 'utf8') <= limit);
  assert.match(d.text, /^AGENT \(.*\):\nq+\[cut\]\n\n$/m);
  assert.ok(!d.text.includes('hello'));
});

test('when not even the header fits the digest is empty and truncated', async (t) => {
  const file = sessionFile(tempDir(t), 'aaaaaaaa.jsonl', '2026-11-09T00:00:00Z');
  assert.deepEqual(await buildDigest({ files: claude(file), repoDir: REPO, maxBytes: 5 }),
    { text: '', sessions: 0, truncated: true, sessionsLeftOut: 1 });
});

function sessionFile(dir, name, lastAt, text = 'hello') {
  const file = join(dir, name);
  writeJsonl(file, [
    user(text, { promptSource: 'typed', timestamp: lastAt }),
    agent('reply', { timestamp: lastAt }),
  ]);
  return file;
}

test('buildDigest orders sessions newest first and formats turns', async (t) => {
  const dir = tempDir(t);
  const old = sessionFile(dir, 'aaaaaaaa-1.jsonl', '2026-11-01T00:00:00Z', 'old one');
  const recent = sessionFile(dir, 'bbbbbbbb-2.jsonl', '2026-11-09T00:00:00Z', 'new one');
  const d = await buildDigest({ files: claude(old, recent), repoDir: REPO, maxBytes: 100000 });
  assert.equal(d.sessions, 2);
  assert.equal(d.truncated, false);
  assert.equal(d.text, [
    '=== Claude Code session bbbbbbbb, 2026-11-09T00:00:00Z to 2026-11-09T00:00:00Z ===',
    'USER (2026-11-09T00:00:00Z):', 'new one', '',
    'AGENT (2026-11-09T00:00:00Z):', 'reply', '',
    '=== Claude Code session aaaaaaaa, 2026-11-01T00:00:00Z to 2026-11-01T00:00:00Z ===',
    'USER (2026-11-01T00:00:00Z):', 'old one', '',
    'AGENT (2026-11-01T00:00:00Z):', 'reply', '', '',
  ].join('\n'));
});

test('buildDigest cuts long turns and redacts flagged lines', async (t) => {
  const dir = tempDir(t);
  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const file = sessionFile(dir, 'cccccccc.jsonl', '2026-11-09T00:00:00Z', `before\nuse ${key} here\nafter ${'z'.repeat(50)}`);
  const d = await buildDigest({ files: claude(file), repoDir: REPO, maxBytes: 100000, perTurnChars: 30 });
  assert.ok(!d.text.includes(key));
  assert.match(d.text, /USER \(.*\):\nbefore\n\[redacted\]\nafter z+\[cut\]\n/);
  const full = await buildDigest({ files: claude(file), repoDir: REPO, maxBytes: 100000 });
  assert.match(full.text, /\n\[redacted\]\n/);
  assert.ok(!full.text.includes('[cut]'));
});

test('buildDigest redacts a private key block through its END line', async (t) => {
  const dir = tempDir(t);
  const begin = '-----BEGIN ' + 'PRIVATE KEY-----';
  const end = '-----END ' + 'PRIVATE KEY-----';
  const file = sessionFile(dir, 'kkkkkkkk.jsonl', '2026-11-09T00:00:00Z', `${begin}\nMIIEvQIBADANBgkq\n${end}\nafter`);
  const d = await buildDigest({ files: claude(file), repoDir: REPO, maxBytes: 100000 });
  assert.ok(!d.text.includes('MIIEvQIBADANBgkq'));
  assert.match(d.text, /\[redacted\]\n\[redacted\]\n\[redacted\]\nafter\n/);
});

test('buildDigest leaves out sessions that are neither interactive nor memory-writing', async (t) => {
  const dir = tempDir(t);
  const headless = join(dir, 'hhhhhhhh.jsonl');
  writeJsonl(headless, [user('batch', { promptSource: 'sdk' }), agent('result')]);
  const writer = join(dir, 'wwwwwwww.jsonl');
  writeJsonl(writer, [user('batch', { promptSource: 'sdk' }),
    agent([{ type: 'text', text: 'saved' }, { type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/x/memory/n.md' } }])]);
  const d = await buildDigest({ files: claude(headless, writer), repoDir: REPO, maxBytes: 100000 });
  assert.equal(d.sessions, 1);
  assert.match(d.text, /session wwwwwwww/);
  assert.ok(!d.text.includes('hhhhhhhh'));
});

// A session of `n` typed turns of `size` characters, tagged `<tag>-<nn>`, the last at `lastAt`, a
// minute apart.
function turnsSession(dir, name, lastAt, n, size, tag) {
  const end = Date.parse(lastAt);
  const file = join(dir, name);
  writeJsonl(file, Array.from({ length: n }, (_, i) => user(`${tag}-${String(i).padStart(2, '0')} ${'w'.repeat(size)}`,
    { promptSource: 'typed', timestamp: new Date(end - (n - 1 - i) * 60000).toISOString() })));
  return file;
}
const turnsOf = (text, tag) => [...text.matchAll(new RegExp(`${tag}-(\\d\\d)`, 'g'))].map((m) => Number(m[1]));
const sessionIds = (text) => [...text.matchAll(/^=== Claude Code session (\w+),/gm)].map((m) => m[1]);

test('a session that does not fit no longer leaves out the older sessions after it', async (t) => {
  const dir = tempDir(t);
  const files = claude(
    turnsSession(dir, 'aaaaaaaa.jsonl', '2026-11-20T10:00:00Z', 1, 900, 'newest'),
    turnsSession(dir, 'bbbbbbbb.jsonl', '2026-11-18T10:00:00Z', 30, 900, 'large'),
    turnsSession(dir, 'cccccccc.jsonl', '2026-11-16T10:00:00Z', 3, 900, 'medium'),
    turnsSession(dir, 'dddddddd.jsonl', '2026-11-15T10:00:00Z', 1, 10, 'oldest'),
  );
  const d = await buildDigest({ files, repoDir: REPO, maxBytes: 12000 });
  assert.deepEqual([d.sessions, d.sessionsLeftOut, d.truncated], [4, 0, true]);
  assert.ok(Buffer.byteLength(d.text, 'utf8') <= 12000);
  assert.deepEqual(sessionIds(d.text), ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd']);
  // The sessions that fit are whole; the large one keeps its newest turns, in their order.
  assert.deepEqual(turnsOf(d.text, 'newest'), [0]);
  assert.deepEqual(turnsOf(d.text, 'medium'), [0, 1, 2]);
  assert.deepEqual(turnsOf(d.text, 'oldest'), [0]);
  const large = turnsOf(d.text, 'large');
  assert.ok(large.length >= 3 && large.length < 30, `${large.length} turns`);
  assert.deepEqual(large, Array.from({ length: large.length }, (_, i) => 30 - large.length + i));
});

test('an oversized newest session leaves room for the older sessions', async (t) => {
  const dir = tempDir(t);
  const files = claude(
    turnsSession(dir, 'aaaaaaaa.jsonl', '2026-11-20T10:00:00Z', 30, 900, 'large'),
    turnsSession(dir, 'bbbbbbbb.jsonl', '2026-11-19T10:00:00Z', 2, 900, 'older'),
  );
  const d = await buildDigest({ files, repoDir: REPO, maxBytes: 8000 });
  assert.deepEqual([d.sessions, d.sessionsLeftOut, d.truncated], [2, 0, true]);
  assert.deepEqual(turnsOf(d.text, 'older'), [0, 1]);
  assert.equal(turnsOf(d.text, 'large').at(-1), 29);
  assert.deepEqual(sessionIds(d.text), ['aaaaaaaa', 'bbbbbbbb']);
});

test('the room a small session does not need goes to the larger ones, an equal share each', async (t) => {
  const dir = tempDir(t);
  const files = claude(
    turnsSession(dir, 'aaaaaaaa.jsonl', '2026-11-20T10:00:00Z', 20, 900, 'first'),
    turnsSession(dir, 'bbbbbbbb.jsonl', '2026-11-19T10:00:00Z', 20, 900, 'second'),
    turnsSession(dir, 'cccccccc.jsonl', '2026-11-18T10:00:00Z', 1, 10, 'small'),
  );
  const d = await buildDigest({ files, repoDir: REPO, maxBytes: 10000 });
  assert.equal(d.sessions, 3);
  assert.deepEqual(turnsOf(d.text, 'small'), [0]);
  const [a, b] = [turnsOf(d.text, 'first').length, turnsOf(d.text, 'second').length];
  assert.ok(a >= 4 && Math.abs(a - b) <= 1, `${a} and ${b} turns`);
  // Less than a turn of each large session is left unused.
  const turn = Buffer.byteLength(d.text.match(/USER \(.*\):\nfirst-19 w+\n\n/)[0], 'utf8');
  assert.ok(10000 - Buffer.byteLength(d.text, 'utf8') < 2 * turn);
});

test('a session for which its least is no longer left is skipped, and an older one that still fits gets its place', async (t) => {
  const dir = tempDir(t);
  const files = claude(
    turnsSession(dir, 'aaaaaaaa.jsonl', '2026-11-20T10:00:00Z', 2, 900, 'newest'),
    turnsSession(dir, 'bbbbbbbb.jsonl', '2026-11-19T10:00:00Z', 2, 900, 'middle'),
    turnsSession(dir, 'cccccccc.jsonl', '2026-11-18T10:00:00Z', 1, 10, 'oldest'),
  );
  // The newest session's least (its header and 512 bytes of its newest turn), then room for the
  // oldest one's short turn but not for the middle one's 512 bytes.
  const one = await buildDigest({ files: [files[0]], repoDir: REPO, maxBytes: 100000 });
  const header = Buffer.byteLength(one.text.split('\n', 1)[0], 'utf8') + 1;
  const label = Buffer.byteLength(one.text.match(/^USER \(.*\):\n/m)[0], 'utf8');
  const d = await buildDigest({ files, repoDir: REPO, maxBytes: header + label + 512 + 7 + 200 });
  assert.deepEqual([d.sessions, d.sessionsLeftOut, d.truncated], [2, 1, true]);
  assert.deepEqual(sessionIds(d.text), ['aaaaaaaa', 'cccccccc']);
  assert.deepEqual(turnsOf(d.text, 'oldest'), [0]);
});

test('many sessions in a small room: each placed keeps 512 bytes of its newest turn, the oldest are left out', async (t) => {
  const dir = tempDir(t);
  const files = claude(...Array.from({ length: 30 }, (_, i) => turnsSession(dir, `${String(i).padStart(8, '0')}.jsonl`,
    new Date(Date.parse('2026-11-20T10:00:00Z') - i * 3600000).toISOString(), 3, 900, `s${String(i).padStart(2, '0')}`)));
  const d = await buildDigest({ files, repoDir: REPO, maxBytes: 10000 });
  assert.ok(d.sessions >= 10 && d.sessions < 30, `${d.sessions} sessions`);
  assert.equal(d.sessions + d.sessionsLeftOut, 30);
  assert.ok(Buffer.byteLength(d.text, 'utf8') <= 10000);
  // The newest sessions are those placed, each with at least 512 bytes of its newest turn.
  assert.deepEqual(sessionIds(d.text), Array.from({ length: d.sessions }, (_, i) => String(i).padStart(8, '0')));
  for (const block of d.text.split(/^=== /m).filter(Boolean)) {
    const turn = block.match(/USER \(.*\):\n(s\d\d-02 w*)/);
    assert.ok(turn && Buffer.byteLength(turn[1], 'utf8') >= 512, block.slice(0, 80));
  }
});

test('when not even the newest turn of an older session fits after the newer ones, that session is left out', async (t) => {
  const dir = tempDir(t);
  const a = sessionFile(dir, 'aaaaaaaa.jsonl', '2026-11-09T00:00:00Z');
  const b = sessionFile(dir, 'bbbbbbbb.jsonl', '2026-11-08T00:00:00Z');
  const one = await buildDigest({ files: claude(a), repoDir: REPO, maxBytes: 100000 });
  const size = Buffer.byteLength(one.text, 'utf8');
  const d = await buildDigest({ files: claude(a, b), repoDir: REPO, maxBytes: size + 10 });
  assert.equal(d.sessions, 1);
  assert.equal(d.truncated, true);
  assert.equal(d.sessionsLeftOut, 1);
  assert.equal(d.text, one.text);
});

// F3: one session of 300 turns, the first half before the window, the second half inside it.
function longSession(dir, windowStart) {
  const file = join(dir, 'llllllll.jsonl');
  const before = new Date(windowStart - 5 * 86400000);
  const inside = new Date(windowStart + 86400000);
  const records = [];
  for (let i = 0; i < 300; i++) {
    const at = new Date((i < 150 ? before : inside).getTime() + i * 1000).toISOString();
    records.push(user(`turn-${String(i).padStart(3, '0')} ${'w'.repeat(900)}`, { promptSource: 'typed', timestamp: at }));
  }
  writeJsonl(file, records);
  return file;
}

test('buildDigest drops turns at or before the window start', async (t) => {
  const since = Date.parse('2026-11-07T00:00:00Z');
  const file = longSession(tempDir(t), since);
  const d = await buildDigest({ files: claude(file), repoDir: REPO, maxBytes: 2000000, since });
  assert.equal(d.truncated, false);
  assert.equal(d.sessionsLeftOut, 0);
  const turns = [...d.text.matchAll(/turn-(\d{3})/g)].map((m) => Number(m[1]));
  assert.equal(turns.length, 150);
  assert.equal(Math.min(...turns), 150);
  assert.match(d.text, /^=== Claude Code session llllllll, 2026-11-08T/m);
  const edge = join(tempDir(t), 'eeeeeeee.jsonl');
  writeJsonl(edge, [
    user('at the start', { promptSource: 'typed', timestamp: new Date(since).toISOString() }),
    user('no time', { promptSource: 'typed' }),
  ]);
  const e = await buildDigest({ files: claude(edge), repoDir: REPO, maxBytes: 100000, since });
  assert.ok(!e.text.includes('at the start'));
  assert.match(e.text, /no time/);
});

test('buildDigest keeps the newest turns of the window when it must cut, in order', async (t) => {
  const since = Date.parse('2026-11-07T00:00:00Z');
  const file = longSession(tempDir(t), since);
  const d = await buildDigest({ files: claude(file), repoDir: REPO, maxBytes: 50000, since });
  assert.equal(d.truncated, true);
  assert.equal(d.sessions, 1);
  const turns = [...d.text.matchAll(/turn-(\d{3})/g)].map((m) => Number(m[1]));
  assert.ok(turns.length > 10 && turns.length < 150);
  assert.equal(turns.at(-1), 299);
  assert.deepEqual(turns, [...turns].sort((a, b) => a - b));
  assert.equal(turns[0], 300 - turns.length);
});

test('a session whose turns all lie before the window is not a session for this run', async (t) => {
  const since = Date.parse('2026-11-07T00:00:00Z');
  const file = join(tempDir(t), 'oooooooo.jsonl');
  writeJsonl(file, [user('old', { promptSource: 'typed', timestamp: '2026-11-01T00:00:00Z' }), agent('reply', { timestamp: '2026-11-01T00:00:05Z' })]);
  assert.deepEqual(await buildDigest({ files: claude(file), repoDir: REPO, maxBytes: 100000, since }),
    { text: '', sessions: 0, truncated: false, sessionsLeftOut: 0 });
});

test('buildDigest includes a first session that alone is too large, keeping its newest turns', async (t) => {
  const dir = tempDir(t);
  const file = sessionFile(dir, 'aaaaaaaa.jsonl', '2026-11-09T00:00:00Z', 'q'.repeat(100));
  const whole = await buildDigest({ files: claude(file), repoDir: REPO, maxBytes: 100000 });
  const limit = Buffer.byteLength(whole.text, 'utf8') - 5;
  const d = await buildDigest({ files: claude(file), repoDir: REPO, maxBytes: limit });
  assert.equal(d.sessions, 1);
  assert.equal(d.truncated, true);
  assert.equal(d.sessionsLeftOut, 0);
  assert.ok(Buffer.byteLength(d.text, 'utf8') <= limit);
  assert.match(d.text, /AGENT/);
  assert.ok(!d.text.includes('USER'));
});

test('buildDigest with nothing qualifying returns an empty digest', async (t) => {
  const dir = tempDir(t);
  const headless = join(dir, 'h.jsonl');
  writeJsonl(headless, [user('batch', { promptSource: 'sdk' }), agent('result')]);
  assert.deepEqual(await buildDigest({ files: claude(headless), repoDir: REPO, maxBytes: 1000 }),
    { text: '', sessions: 0, truncated: false, sessionsLeftOut: 0 });
  assert.deepEqual(await buildDigest({ files: claude(), repoDir: REPO, maxBytes: 1000 }),
    { text: '', sessions: 0, truncated: false, sessionsLeftOut: 0 });
});

test('projectSessionDirs lists every folder linked to a project and ignores the rest', (t) => {
  const root = tempDir(t);
  const repoDir = join(root, 'repo');
  const claudeDir = join(root, 'claude');
  mkdirSync(join(repoDir, 'projects/alpha'), { recursive: true });
  mkdirSync(join(repoDir, 'projects/beta'), { recursive: true });
  mkdirSync(join(root, 'elsewhere'), { recursive: true });
  const slug = (name) => {
    const d = join(claudeDir, 'projects', name);
    mkdirSync(d, { recursive: true });
    return d;
  };
  symlinkSync(join(repoDir, 'projects/alpha'), join(slug('-one'), 'memory'));
  symlinkSync(join(repoDir, 'projects/alpha'), join(slug('-two'), 'memory'));
  symlinkSync(join(repoDir, 'projects/beta'), join(slug('-three'), 'memory'));
  mkdirSync(join(slug('-real'), 'memory'));
  symlinkSync(join(root, 'gone'), join(slug('-dangling'), 'memory'));
  symlinkSync(join(root, 'elsewhere'), join(slug('-other'), 'memory'));
  slug('-nomemory');
  const map = projectSessionDirs({ repoDir, claudeDir });
  assert.deepEqual([...map.keys()].sort(), ['alpha', 'beta']);
  assert.deepEqual(map.get('alpha').sort(), [join(claudeDir, 'projects/-one'), join(claudeDir, 'projects/-two')]);
  assert.deepEqual(map.get('beta'), [join(claudeDir, 'projects/-three')]);
});

test('projectSessionDirs returns an empty map when folders are missing', (t) => {
  const root = tempDir(t);
  assert.equal(projectSessionDirs({ repoDir: join(root, 'r'), claudeDir: join(root, 'c') }).size, 0);
});

test('sessionFilesSince returns only top-level jsonl files newer than the bound', (t) => {
  const dir = tempDir(t);
  const touch = (path, sec) => {
    writeFileSync(path, '{}\n');
    utimesSync(path, sec, sec);
  };
  mkdirSync(join(dir, 'sub'));
  touch(join(dir, 'new.jsonl'), 2000);
  touch(join(dir, 'old.jsonl'), 500);
  touch(join(dir, 'notes.txt'), 2000);
  touch(join(dir, 'sub/deep.jsonl'), 2000);
  assert.deepEqual(sessionFilesSince([dir], 1000 * 1000), [join(dir, 'new.jsonl')]);
});

// ---- Codex sessions ----
// Codex's session format is not a documented interface. These records are small, synthetic copies
// of the shapes it writes: a session_meta line first, then event_msg and response_item records.

const CX_START = Date.parse('2026-11-10T10:00:00.000Z');
const cxAt = (min) => new Date(CX_START + min * 60000).toISOString();
const cxRec = (min, type, payload, extra = {}) => ({ timestamp: cxAt(min), type, payload, ...extra });
const cx = {
  meta: (cwd, source = 'vscode', extra = {}) => cxRec(0, 'session_meta', {
    session_id: 's', id: 'i', timestamp: cxAt(0), cwd, originator: 'codex-tui', cli_version: '0.170.0', source,
    base_instructions: { text: 'BASE-INSTRUCTIONS-NEVER-IN-DIGEST' }, git: { repository_url: 'https://example.com/owner/app.git' }, ...extra,
  }),
  user: (text, min) => cxRec(min, 'event_msg', { type: 'item_completed', item: { type: 'UserMessage', id: `u${min}`, content: [{ type: 'text', text, text_elements: [] }] } }),
  agent: (text, min, phase = 'final_answer') => cxRec(min, 'event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: `a${min}`, content: [{ type: 'text', text }], phase } }),
  oldUser: (text, min, extra = {}) => cxRec(min, 'event_msg', { type: 'user_message', message: text, ...extra }),
  oldAgent: (text, min) => cxRec(min, 'event_msg', { type: 'agent_message', message: text }),
  said: (role, text, min) => cxRec(min, 'response_item', { type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] }),
  command: (output, min) => cxRec(min, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: `c${min}`, command: ['ls'], cwd: '/x', aggregated_output: output, status: 'completed' } }),
  fileChange: (changes, min = 1) => cxRec(min, 'event_msg', { type: 'item_completed', item: { type: 'FileChange', id: `f${min}`, status: 'completed', changes } }),
  mcp: (server, tool, min = 1) => cxRec(min, 'event_msg', { type: 'item_completed', item: { type: 'McpToolCall', id: `m${min}`, server, tool, arguments: {}, status: 'completed' } }),
};
const added = (...paths) => Object.fromEntries(paths.map((path) => [path, { type: 'add', content: 'x' }]));

function codexFile(dir, name, records) {
  const file = join(dir, name);
  writeJsonl(file, records);
  return file;
}

test('a Codex session yields what the person typed and what the agent said, in order', async (t) => {
  const file = codexFile(tempDir(t), 'rollout-a.jsonl', [
    cx.meta('/w/app'),
    cxRec(1, 'response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>secret developer text' }] }),
    cx.said('user', '<environment_context>\n  <cwd>/w/app</cwd>\n</environment_context>', 1),
    cx.said('user', 'what is the staging port?', 2),
    cx.user('what is the staging port?', 2),
    cxRec(3, 'response_item', { type: 'reasoning', summary: [], content: 'HIDDEN-REASONING' }),
    cx.command('TOOL-OUTPUT-NEVER-IN-DIGEST', 3),
    cx.agent('Checking the config.', 4, 'commentary'),
    cx.said('assistant', 'Checking the config.', 4),
    cx.agent('It is 8443.', 5),
    cxRec(6, 'event_msg', { type: 'token_count', info: null }),
  ]);
  const s = await readCodexSession(file, REPO);
  assert.equal(s.interactive, true);
  assert.equal(s.wroteMemory, false);
  assert.deepEqual(s.turns, [
    { role: 'user', at: cxAt(2), text: 'what is the staging port?' },
    { role: 'agent', at: cxAt(4), text: 'Checking the config.' },
    { role: 'agent', at: cxAt(5), text: 'It is 8443.' },
  ]);
  assert.equal(s.firstAt, cxAt(2));
  assert.equal(s.lastAt, cxAt(5));
});

test('the older event records of Codex are read the same way', async (t) => {
  const file = codexFile(tempDir(t), 'rollout-b.jsonl', [
    cx.meta('/w/app', 'cli'),
    cx.oldUser('<user_instructions>AGENTS.md text</user_instructions>', 1, { kind: 'user_instructions' }),
    cx.oldUser('deploy it', 2, { kind: 'plain', images: [] }),
    cx.said('user', 'deploy it', 2),
    cx.oldAgent('Deployed.', 3),
    cx.said('assistant', 'Deployed.', 3),
    cx.oldUser('and the docs', 4),
  ]);
  const s = await readCodexSession(file, REPO);
  assert.equal(s.interactive, true);
  assert.deepEqual(s.turns.map((x) => [x.role, x.text]), [['user', 'deploy it'], ['agent', 'Deployed.'], ['user', 'and the docs']]);
});

test('without event records the messages of the response items are read, without what Codex adds to them', async (t) => {
  const file = codexFile(tempDir(t), 'rollout-c.jsonl', [
    cx.meta('/w/app'),
    cx.said('user', '# AGENTS.md instructions for /w/app\n\nAlways run the tests.', 1),
    cx.said('user', '<environment_context>\n  <cwd>/w/app</cwd>\n</environment_context>', 1),
    cxRec(2, 'response_item', { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<codex_internal_context source="x">ignored</codex_internal_context>' },
      { type: 'input_text', text: 'rename the module' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ] }),
    cx.said('assistant', 'Renamed.', 3),
  ]);
  const s = await readCodexSession(file, REPO);
  assert.deepEqual(s.turns.map((x) => [x.role, x.text]), [['user', 'rename the module'], ['agent', 'Renamed.']]);
});

test('only sessions whose source is cli or vscode count as typed by a person', async (t) => {
  const dir = tempDir(t);
  const sourced = async (source, i) => {
    const meta = cx.meta('/w/app', source);
    if (source === undefined) delete meta.payload.source;
    return (await readCodexSession(codexFile(dir, `rollout-s${i}.jsonl`, [meta, cx.user('hi', 1)]), REPO)).interactive;
  };
  const cases = [['cli', true], ['vscode', true], ['exec', false], ['mcp', false], ['unknown', false], [undefined, false],
    [{ subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1 } } }, false], [{ subagent: 'review' }, false]];
  for (const [i, [source, want]] of cases.entries()) assert.equal(await sourced(source, i), want, JSON.stringify(source));
  // Only the session's own record counts: a forked thread also carries its parent's.
  const forked = codexFile(dir, 'rollout-forked.jsonl', [cx.meta('/w/app', { subagent: { thread_spawn: {} } }), cx.meta('/w/app', 'vscode'), cx.user('hi', 1)]);
  assert.equal((await readCodexSession(forked, REPO)).interactive, false);
  // A session without its record (a file cut at the start) is not typed by a person either.
  assert.equal((await readCodexSession(codexFile(dir, 'rollout-nometa.jsonl', [cx.user('hi', 1)]), REPO)).interactive, false);
});

test('a Codex session wrote memory when it changed a file in the clone or called the memory API\'s write tool', async (t) => {
  const dir = tempDir(t);
  let n = 0;
  const wrote = async (...records) => (await readCodexSession(codexFile(dir, `rollout-w${n++}.jsonl`, [cx.meta('/w/app', 'exec'), ...records]), REPO)).wroteMemory;
  assert.equal(await wrote(cx.fileChange(added(`${REPO}/projects/app/port.md`, `${REPO}/projects/app/MEMORY.md`))), true);
  assert.equal(await wrote(cx.fileChange(added('/w/app/src/main.js'))), false);
  assert.equal(await wrote(cx.fileChange(added(`${REPO}-other/x.md`, `${REPO}/../x.md`))), false);
  assert.equal(await wrote(cx.fileChange({ '/tmp/draft.md': { type: 'update', unified_diff: '', move_path: `${REPO}/global/x.md` } })), true);
  // Older versions: patch events and the apply_patch tool, whose paths may be relative to the session's directory.
  assert.equal(await wrote(cxRec(1, 'event_msg', { type: 'patch_apply_begin', call_id: 'c', changes: { [`${REPO}/global/a.md`]: { add: { content: 'x' } } } })), true);
  assert.equal(await wrote(cxRec(1, 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c', input: `*** Begin Patch\n*** Add File: ${REPO}/projects/app/n.md\n+x\n*** End Patch\n` })), true);
  const shell = { command: ['apply_patch', `*** Begin Patch\n*** Update File: ${REPO}/global/x.md\n@@\n-a\n+b\n*** End Patch\n`] };
  assert.equal(await wrote(cxRec(1, 'response_item', { type: 'function_call', name: 'shell', call_id: 'c', arguments: JSON.stringify(shell) })), true);
  const relative = codexFile(dir, 'rollout-rel.jsonl', [cx.meta(REPO, 'exec'),
    cxRec(1, 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c', input: '*** Begin Patch\n*** Add File: projects/app/n.md\n+x\n*** End Patch\n' })]);
  assert.equal((await readCodexSession(relative, REPO)).wroteMemory, true);
  assert.equal(await wrote(cxRec(1, 'response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c', input: '*** Begin Patch\n*** Add File: src/n.md\n+x\n*** End Patch\n' })), false);
  // The memory API's write tool, however the gateway or the client names it; its read tools are not writes.
  assert.equal(await wrote(cx.mcp('mcp-hub', 'agent-memory___memory_write')), true);
  assert.equal(await wrote(cx.mcp('mcp-hub', 'agent-memory___memory_search')), false);
  assert.equal(await wrote(cxRec(1, 'event_msg', { type: 'mcp_tool_call_begin', call_id: 'c', invocation: { server: 'memory', tool: 'memory_write', arguments: {} } })), true);
  assert.equal(await wrote(cxRec(1, 'response_item', { type: 'function_call', name: 'mcp__mcp-hub__agent-memory___memory_write', call_id: 'c', arguments: '{}' })), true);
});

test('a forked thread leaves out the history it copied from its parent', async (t) => {
  const file = codexFile(tempDir(t), 'rollout-fork.jsonl', [
    cx.meta('/w/app', { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 1 } } }, { forked_from_id: 'p', subagent_history_start_ordinal: 3 }),
    { ...cx.user('PARENT-TURN', 1), ordinal: 1 },
    { ...cx.agent('PARENT-ANSWER', 1), ordinal: 2 },
    { ...cx.user('the task for the sub-agent', 2), ordinal: 3 },
    { ...cx.fileChange(added(`${REPO}/projects/app/n.md`), 3), ordinal: 4 },
    { ...cx.agent('Done.', 4), ordinal: 5 },
  ]);
  const s = await readCodexSession(file, REPO);
  assert.equal(s.wroteMemory, true);
  // The parent's answer is not the thread's, and the task its parent wrote is not typed by the person.
  assert.deepEqual(s.turns.map((x) => x.text), ['Done.']);
});

test('unknown records and malformed lines of a Codex session are skipped, never fatal', async (t) => {
  const file = codexFile(tempDir(t), 'rollout-junk.jsonl', [
    cx.meta('/w/app'),
    'not json',
    '{"type":"event_msg", broken',
    '{"timestamp":"x","type":"event_msg","payload":null}',
    { type: 'event_msg', payload: { type: 'item_completed' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: 'not an array' } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', changes: ['not', 'a', 'map'] } } },
    { type: 'event_msg', payload: { type: 'user_message', message: 42 } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{bad json' } },
    { type: 'some_future_record', payload: { type: 'UserMessage', text: 'ignored' } },
    cx.user('the one real turn', 3),
    'null', '[]', '"string"',
  ]);
  const s = await readCodexSession(file, REPO);
  assert.deepEqual(s.turns.map((x) => x.text), ['the one real turn']);
  assert.equal(s.wroteMemory, false);
});

test('only Codex lines that can hold a turn, a write or the session record are parsed', async (t) => {
  const noise = Array.from({ length: 40 }, (_, i) => [
    cxRec(1, 'event_msg', { type: 'token_count', info: { n: i } }),
    cxRec(1, 'response_item', { type: 'reasoning', content: 'r'.repeat(1000) }),
    cx.command('o'.repeat(5000), 1),
    cxRec(1, 'response_item', { type: 'custom_tool_call_output', call_id: 'c', output: 'p'.repeat(5000) }),
  ]).flat();
  const file = codexFile(tempDir(t), 'rollout-big.jsonl', [cx.meta('/w/app'), ...noise, cx.user('q', 2), ...noise, cx.agent('a', 3)]);
  let calls = 0;
  const s = await readCodexSession(file, REPO, (line) => {
    calls++;
    return JSON.parse(line);
  });
  assert.equal(calls, 3);
  assert.equal(s.turns.length, 2);
});

const codex = (...files) => files.map((file) => ({ tool: 'codex', file }));

test('TC-EXTRACT-CODEX-002: automated Codex runs and sub-agent threads are read only when they wrote memory', async (t) => {
  const dir = tempDir(t);
  const exec = codexFile(dir, 'rollout-2026-11-10T10-00-00-0000-eeeeeeee.jsonl', [cx.meta('/w/app', 'exec'), cx.user('EXEC-PROMPT', 1), cx.agent('EXEC-REPLY', 2)]);
  const sub = codexFile(dir, 'rollout-2026-11-10T10-00-00-0000-ssssssss.jsonl', [cx.meta('/w/app', { subagent: { thread_spawn: {} } }), cx.user('SUB-TASK', 1)]);
  const writer = codexFile(dir, 'rollout-2026-11-10T10-00-00-0000-wwwwwwww.jsonl', [cx.meta('/w/app', 'exec'), cx.user('WRITER-PROMPT', 1),
    cx.fileChange(added(`${REPO}/projects/app/port.md`), 2), cx.agent('Saved the port.', 3)]);
  const d = await buildDigest({ files: codex(exec, sub, writer), repoDir: REPO, maxBytes: 100000 });
  assert.equal(d.sessions, 1);
  assert.match(d.text, /^=== Codex session wwwwwwww, /);
  assert.match(d.text, /^AGENT \(.+\):\nSaved the port\.$/m);
  // Its prompt was written by a program, not typed by the person: it is not in the digest.
  assert.doesNotMatch(d.text, /WRITER-PROMPT|USER/);
  assert.doesNotMatch(d.text, /EXEC-|SUB-TASK|BASE-INSTRUCTIONS/);
});

test('the context block the Codex app puts in front of a typed message is left out', async (t) => {
  const file = codexFile(tempDir(t), 'rollout-ctx.jsonl', [
    cx.meta('/w/app'),
    cx.user('<in-app-browser-context>\n<url>https://example.com/page?token=x</url>\n</in-app-browser-context>\nwhy is this page blank?', 1),
    cx.user('<send_user_message_question_reply>yes, go ahead</send_user_message_question_reply>', 2),
  ]);
  const s = await readCodexSession(file, REPO);
  assert.deepEqual(s.turns.map((x) => x.text), ['why is this page blank?', '<send_user_message_question_reply>yes, go ahead</send_user_message_question_reply>']);
});

test('TC-EXTRACT-CODEX-003: Claude Code and Codex sessions share the window, the size limit and the newest-first order', async (t) => {
  const dir = tempDir(t);
  const since = CX_START + 30 * 60000;
  const claudeFile = join(dir, 'cccccccc.jsonl');
  writeJsonl(claudeFile, [
    user('CLAUDE-BEFORE-WINDOW', { promptSource: 'typed', timestamp: cxAt(10) }),
    user('CLAUDE-NEWEST', { promptSource: 'typed', timestamp: cxAt(90) }),
  ]);
  const codexNew = codexFile(dir, 'rollout-2026-11-10T10-00-00-0000-11111111.jsonl', [cx.meta('/w/app'), cx.user('CODEX-BEFORE-WINDOW', 20), cx.user('CODEX-MIDDLE', 60)]);
  const codexOld = codexFile(dir, 'rollout-2026-11-10T10-00-00-0000-22222222.jsonl', [cx.meta('/w/app'), cx.user('CODEX-OLDEST', 40)]);
  const files = [...codex(codexOld), ...claude(claudeFile), ...codex(codexNew)];
  const all = await buildDigest({ files, repoDir: REPO, maxBytes: 100000, since });
  assert.equal(all.sessions, 3);
  assert.doesNotMatch(all.text, /BEFORE-WINDOW/);
  const order = [...all.text.matchAll(/^=== (Claude Code|Codex) session (\w+),/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(order, ['Claude Code cccccccc', 'Codex 11111111', 'Codex 22222222']);
  // A limit that holds two sessions leaves out the oldest, whichever tool it came from.
  const two = all.text.slice(0, all.text.indexOf('=== Codex session 22222222'));
  const cut = await buildDigest({ files, repoDir: REPO, maxBytes: Buffer.byteLength(two, 'utf8') + 10, since });
  assert.equal(cut.text, two);
  assert.equal(cut.sessions, 2);
  assert.equal(cut.truncated, true);
  assert.equal(cut.sessionsLeftOut, 1);
});

test('TC-EXTRACT-CODEX-004: a line of a Codex session that the secret scan flags is redacted', async (t) => {
  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const file = codexFile(tempDir(t), 'rollout-2026-11-10T10-00-00-0000-kkkkkkkk.jsonl', [cx.meta('/w/app'),
    cx.user(`before\nexport KEY=${key}\nafter`, 1), cx.agent(`Stored ${key} for you.`, 2)]);
  const d = await buildDigest({ files: codex(file), repoDir: REPO, maxBytes: 100000 });
  assert.ok(!d.text.includes(key));
  assert.match(d.text, /USER \(.*\):\nbefore\n\[redacted\]\nafter\n/);
  assert.match(d.text, /AGENT \(.*\):\n\[redacted\]\n/);
});

// ---- which project a Codex session belongs to (TC-EXTRACT-CODEX-001) ----

function codexHomeFixture(t) {
  const root = tempDir(t);
  const repoDir = join(root, 'notes');
  const codexDir = join(root, 'codex');
  const marker = (project, identity) => {
    mkdirSync(join(repoDir, 'projects', project), { recursive: true });
    writeFileSync(join(repoDir, 'projects', project, '.project'), `${identity}\n`);
  };
  const gitRepo = (dir, origin) => {
    mkdirSync(dir, { recursive: true });
    sh(dir, 'git', ['init', '-q', '-b', 'main']);
    if (origin) sh(dir, 'git', ['remote', 'add', 'origin', origin]);
    return realpathSync(dir);
  };
  let n = 0;
  const now = Date.now();
  // A session file in Codex's layout, last written `ageMs` ago.
  const session = (cwd, { ageMs = 3600 * 1000, url, day = '2026/11/18', name } = {}) => {
    const folder = join(codexDir, 'sessions', ...day.split('/'));
    mkdirSync(folder, { recursive: true });
    const file = join(folder, name ?? `rollout-2026-11-18T10-00-00-0000-${String(n++).padStart(8, '0')}.jsonl`);
    // `url`: the repository the session recorded; null records none.
    writeJsonl(file, [cx.meta(cwd, 'vscode', url === undefined ? {} : { git: url === null ? undefined : { repository_url: url } }), cx.user('hi', 1)]);
    const then = new Date(now - ageMs);
    utimesSync(file, then, then);
    return file;
  };
  const config = { host: 'alpha', repoDir, codexDir };
  return { root, repoDir, codexDir, config, marker, gitRepo, session, now };
}

test('TC-EXTRACT-CODEX-001: a Codex session belongs to the project whose .project matches the repository of its directory', (t) => {
  const f = codexHomeFixture(t);
  const app = f.gitRepo(join(f.root, 'src', 'app'), 'https://example.com/owner/app.git');
  f.gitRepo(join(f.root, 'src', 'lib'), 'git@example.com:owner/lib.git');
  const other = f.gitRepo(join(f.root, 'elsewhere', 'app'), 'https://example.com/someone-else/app.git');
  const local = f.gitRepo(join(f.root, 'src', 'scratch'), null);
  f.marker('app', 'example.com/owner/app');
  f.marker('scratch', `local/alpha${local}`);
  mkdirSync(join(app, 'pkg'));
  sh(app, 'git', ['commit', '-q', '--allow-empty', '-m', 'init']);
  sh(app, 'git', ['worktree', 'add', '-q', join(f.root, 'wt'), '-b', 'topic']);
  const inApp = f.session(app);
  const inSubfolder = f.session(join(app, 'pkg'));
  const inWorktree = f.session(join(f.root, 'wt'));
  const inLocal = f.session(local);
  f.session(other); // same directory name, another repository
  f.session(join(f.root, 'src', 'lib')); // no project folder
  f.session(f.root); // not a repository
  f.session('relative/path');
  const projects = codexProjectSessions(f.config, { sinceMs: f.now - 86400 * 1000, projects: ['app', 'scratch', 'other'] });
  assert.deepEqual([...projects.keys()].sort(), ['app', 'scratch']);
  assert.deepEqual(projects.get('app').sort(), [inApp, inSubfolder, inWorktree].sort());
  assert.deepEqual(projects.get('scratch'), [inLocal]);
});

test('a Codex session of a repository that gained an origin still belongs to the folder its machine identity bound', (t) => {
  const f = codexHomeFixture(t);
  const app = f.gitRepo(join(f.root, 'src', 'app'), 'https://example.com/owner/app.git');
  f.marker('app', `local/alpha${app}`);
  const file = f.session(app);
  assert.deepEqual(codexProjectSessions(f.config, { sinceMs: f.now - 86400 * 1000, projects: ['app'] }).get('app'), [file]);
  // A machine identity of another machine or directory is not this repository.
  f.marker('app', `local/beta${app}`);
  assert.equal(codexProjectSessions(f.config, { sinceMs: f.now - 86400 * 1000, projects: ['app'] }).size, 0);
  assert.equal(codexProjectSessions({ ...f.config, codexDir: null }, { sinceMs: 0, projects: ['app'] }).size, 0);
});

test('a Codex session in a folder that is gone counts only when the repository it recorded is the one around it', (t) => {
  const f = codexHomeFixture(t);
  const app = f.gitRepo(join(f.root, 'src', 'app'), 'https://example.com/owner/app.git');
  f.marker('app', 'example.com/owner/app');
  mkdirSync(join(app, '.worktrees'));
  const gone = join(app, '.worktrees', 'feat', 'removed');
  const kept = f.session(gone, { url: 'git@example.com:owner/app.git' });
  f.session(gone, { url: 'https://example.com/owner/vendored-lib.git' }); // a nested clone that was removed
  f.session(join(app, '.worktrees', 'gone-too'), { url: null }); // no repository recorded
  const projects = codexProjectSessions(f.config, { sinceMs: f.now - 86400 * 1000, projects: ['app'] });
  assert.deepEqual(projects.get('app'), [kept]);
});

test('only regular rollout files in the date folders, written after the bound, are taken', (t) => {
  const f = codexHomeFixture(t);
  const app = f.gitRepo(join(f.root, 'src', 'app'), 'https://example.com/owner/app.git');
  f.marker('app', 'example.com/owner/app');
  const fresh = f.session(app);
  f.session(app, { ageMs: 3 * 86400 * 1000 }); // older than the bound
  f.session(app, { name: 'notes.jsonl' });
  f.session(app, { day: '2026/11' }); // not a day folder
  f.session(app, { day: '2026/11/18/deeper' });
  symlinkSync(fresh, join(f.codexDir, 'sessions', '2026', '11', '18', 'rollout-2026-11-18T10-00-00-0000-linklink.jsonl'));
  writeFileSync(join(f.codexDir, 'sessions', '2026', '11', '18', 'rollout-empty.jsonl'), '');
  writeFileSync(join(f.codexDir, 'sessions', '2026', '11', '18', 'rollout-garbage.jsonl'), 'not json\n');
  const projects = codexProjectSessions(f.config, { sinceMs: f.now - 86400 * 1000, projects: ['app'] });
  assert.deepEqual(projects.get('app'), [fresh]);
  // Projects not asked for, and a missing Codex folder, give nothing.
  assert.equal(codexProjectSessions(f.config, { sinceMs: 0, projects: [] }).size, 0);
  rmSync(f.codexDir, { recursive: true });
  assert.equal(codexProjectSessions(f.config, { sinceMs: 0, projects: ['app'] }).size, 0);
});
