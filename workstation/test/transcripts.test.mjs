import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDigest, projectSessionDirs, readSession, sessionFilesSince } from '../lib/transcripts.mjs';
import { tempDir } from './helpers.mjs';

const REPO = '/home/u/agent-memory';

function user(text, extra = {}) {
  return { type: 'user', timestamp: '2026-11-10T10:00:00Z', message: { role: 'user', content: text }, ...extra };
}
function agent(content, extra = {}) {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
  return { type: 'assistant', timestamp: '2026-11-10T10:00:05Z', message: { role: 'assistant', content: blocks }, ...extra };
}
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
  const s = await readSession(file, REPO);
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
  const s = await readSession(plain, REPO);
  assert.equal(s.interactive, false);
  assert.equal(s.wroteMemory, false);
  assert.deepEqual(s.turns.map((x) => x.role), ['agent']);

  const write = (name, path, tool = 'Write') => {
    const f = join(dir, name);
    writeJsonl(f, [user('x', { promptSource: 'sdk' }),
      agent([{ type: 'tool_use', id: 'w', name: tool, input: { file_path: path } }])]);
    return readSession(f, REPO);
  };
  assert.equal((await write('b.jsonl', '/home/u/.claude/projects/p/memory/x.md')).wroteMemory, true);
  assert.equal((await write('c.jsonl', `${REPO}/projects/p/x.md`, 'Edit')).wroteMemory, true);
  assert.equal((await write('d.jsonl', '/home/u/work/code.js')).wroteMemory, false);
  assert.equal((await write('e.jsonl', `${REPO}-other/x.md`)).wroteMemory, false);
});

test('without promptSource the entrypoint of most records decides', async (t) => {
  const dir = tempDir(t);
  const cli = join(dir, 'cli.jsonl');
  writeJsonl(cli, [user('a', { entrypoint: 'cli' }), agent('b', { entrypoint: 'cli' }), agent('c', { entrypoint: 'sdk-cli' })]);
  assert.equal((await readSession(cli, REPO)).interactive, true);
  const sdk = join(dir, 'sdk.jsonl');
  writeJsonl(sdk, [user('a', { entrypoint: 'sdk-cli' }), agent('b', { entrypoint: 'sdk-cli' }), agent('c', { entrypoint: 'cli' })]);
  assert.equal((await readSession(sdk, REPO)).interactive, false);
});

test('system reminders are removed and a reminder-only turn is dropped', async (t) => {
  const file = join(tempDir(t), 'r.jsonl');
  writeJsonl(file, [
    user('<system-reminder>\nhidden\n</system-reminder>', { promptSource: 'typed' }),
    user('keep this <system-reminder>secret hint</system-reminder>text', { promptSource: 'typed' }),
  ]);
  const s = await readSession(file, REPO);
  assert.deepEqual(s.turns.map((x) => x.text), ['keep this text']);
});

test('lines of other record types are skipped without being parsed; bad lines are skipped', async (t) => {
  const file = join(tempDir(t), 'big.jsonl');
  const junk = `{"type":"attachment","data":"${'x'.repeat(2 * 1024 * 1024)}`; // not valid JSON
  writeJsonl(file, [junk, '{"type":"user", broken', user('ok', { promptSource: 'typed' })]);
  const s = await readSession(file, REPO);
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
  const s = await readSession(file, REPO, parse);
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
  const s = await readSession(file, REPO);
  assert.deepEqual(s.turns.map((x) => x.at), [null, '2026-11-10T10:00:05Z']);
  assert.equal(s.firstAt, '2026-11-10T10:00:05Z');
  const d = await buildDigest({ files: [file], repoDir: REPO, maxBytes: 100000 });
  assert.ok(!d.text.includes('fake'));
  assert.match(d.text, /^USER:\nhello$/m);
  assert.match(d.text, /^AGENT \(2026-11-10T10:00:05Z\):$/m);
});

test('a session without any timestamp prints unknown in the header', async (t) => {
  const file = join(tempDir(t), 'nnnnnnnn.jsonl');
  writeJsonl(file, [user('hi', { promptSource: 'typed', timestamp: 5 })]);
  const d = await buildDigest({ files: [file], repoDir: REPO, maxBytes: 100000 });
  assert.equal(d.text, '=== session nnnnnnnn, unknown to unknown ===\nUSER:\nhi\n\n');
});

test('buildDigest skips a file that cannot be read', async (t) => {
  const dir = tempDir(t);
  const good = sessionFile(dir, 'gggggggg.jsonl', '2026-11-09T00:00:00Z');
  const d = await buildDigest({ files: [join(dir, 'missing.jsonl'), dir, good], repoDir: REPO, maxBytes: 100000 });
  assert.equal(d.sessions, 1);
  assert.match(d.text, /session gggggggg/);
});

test('an oversized first turn is cut further so header and one turn fit', async (t) => {
  const dir = tempDir(t);
  const file = sessionFile(dir, 'aaaaaaaa.jsonl', '2026-11-09T00:00:00Z', 'q'.repeat(500));
  const header = '=== session aaaaaaaa, 2026-11-09T00:00:00Z to 2026-11-09T00:00:00Z ===\n';
  const limit = Buffer.byteLength(header, 'utf8') + 80;
  const d = await buildDigest({ files: [file], repoDir: REPO, maxBytes: limit });
  assert.equal(d.sessions, 1);
  assert.equal(d.truncated, true);
  assert.ok(Buffer.byteLength(d.text, 'utf8') <= limit);
  assert.match(d.text, /USER \(.*\):\nq+\[cut\]\n\n$/);
});

test('when not even the header fits the digest is empty and truncated', async (t) => {
  const file = sessionFile(tempDir(t), 'aaaaaaaa.jsonl', '2026-11-09T00:00:00Z');
  assert.deepEqual(await buildDigest({ files: [file], repoDir: REPO, maxBytes: 5 }),
    { text: '', sessions: 0, truncated: true });
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
  const d = await buildDigest({ files: [old, recent], repoDir: REPO, maxBytes: 100000 });
  assert.equal(d.sessions, 2);
  assert.equal(d.truncated, false);
  assert.equal(d.text, [
    '=== session bbbbbbbb, 2026-11-09T00:00:00Z to 2026-11-09T00:00:00Z ===',
    'USER (2026-11-09T00:00:00Z):', 'new one', '',
    'AGENT (2026-11-09T00:00:00Z):', 'reply', '',
    '=== session aaaaaaaa, 2026-11-01T00:00:00Z to 2026-11-01T00:00:00Z ===',
    'USER (2026-11-01T00:00:00Z):', 'old one', '',
    'AGENT (2026-11-01T00:00:00Z):', 'reply', '', '',
  ].join('\n'));
});

test('buildDigest cuts long turns and redacts flagged lines', async (t) => {
  const dir = tempDir(t);
  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const file = sessionFile(dir, 'cccccccc.jsonl', '2026-11-09T00:00:00Z', `before\nuse ${key} here\nafter ${'z'.repeat(50)}`);
  const d = await buildDigest({ files: [file], repoDir: REPO, maxBytes: 100000, perTurnChars: 30 });
  assert.ok(!d.text.includes(key));
  assert.match(d.text, /USER \(.*\):\nbefore\n\[redacted\]\nafter z+\[cut\]\n/);
  const full = await buildDigest({ files: [file], repoDir: REPO, maxBytes: 100000 });
  assert.match(full.text, /\n\[redacted\]\n/);
  assert.ok(!full.text.includes('[cut]'));
});

test('buildDigest redacts a private key block through its END line', async (t) => {
  const dir = tempDir(t);
  const begin = '-----BEGIN ' + 'PRIVATE KEY-----';
  const end = '-----END ' + 'PRIVATE KEY-----';
  const file = sessionFile(dir, 'kkkkkkkk.jsonl', '2026-11-09T00:00:00Z', `${begin}\nMIIEvQIBADANBgkq\n${end}\nafter`);
  const d = await buildDigest({ files: [file], repoDir: REPO, maxBytes: 100000 });
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
  const d = await buildDigest({ files: [headless, writer], repoDir: REPO, maxBytes: 100000 });
  assert.equal(d.sessions, 1);
  assert.match(d.text, /session wwwwwwww/);
  assert.ok(!d.text.includes('hhhhhhhh'));
});

test('buildDigest stops before a session that would pass maxBytes', async (t) => {
  const dir = tempDir(t);
  const a = sessionFile(dir, 'aaaaaaaa.jsonl', '2026-11-09T00:00:00Z');
  const b = sessionFile(dir, 'bbbbbbbb.jsonl', '2026-11-08T00:00:00Z');
  const one = await buildDigest({ files: [a], repoDir: REPO, maxBytes: 100000 });
  const size = Buffer.byteLength(one.text, 'utf8');
  const d = await buildDigest({ files: [a, b], repoDir: REPO, maxBytes: size + 10 });
  assert.equal(d.sessions, 1);
  assert.equal(d.truncated, true);
  assert.equal(d.text, one.text);
});

test('buildDigest includes a first session that alone is too large, cut at a turn boundary', async (t) => {
  const dir = tempDir(t);
  const file = sessionFile(dir, 'aaaaaaaa.jsonl', '2026-11-09T00:00:00Z', 'q'.repeat(100));
  const whole = await buildDigest({ files: [file], repoDir: REPO, maxBytes: 100000 });
  const limit = Buffer.byteLength(whole.text, 'utf8') - 5;
  const d = await buildDigest({ files: [file], repoDir: REPO, maxBytes: limit });
  assert.equal(d.sessions, 1);
  assert.equal(d.truncated, true);
  assert.ok(Buffer.byteLength(d.text, 'utf8') <= limit);
  assert.match(d.text, /USER/);
  assert.ok(!d.text.includes('AGENT'));
});

test('buildDigest with nothing qualifying returns an empty digest', async (t) => {
  const dir = tempDir(t);
  const headless = join(dir, 'h.jsonl');
  writeJsonl(headless, [user('batch', { promptSource: 'sdk' }), agent('result')]);
  assert.deepEqual(await buildDigest({ files: [headless], repoDir: REPO, maxBytes: 1000 }),
    { text: '', sessions: 0, truncated: false });
  assert.deepEqual(await buildDigest({ files: [], repoDir: REPO, maxBytes: 1000 }),
    { text: '', sessions: 0, truncated: false });
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
