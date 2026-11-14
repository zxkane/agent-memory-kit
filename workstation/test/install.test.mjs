import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_MARKER, LAUNCHER_REL, install, kiroHookDocument, mergeCodexHooks, mergeHooks, removeHooks, toolCommand } from '../install.mjs';
import { tempDir } from './helpers.mjs';

const RUN = '/srv/kit/workstation/run.sh';

function fixture(t) {
  const base = tempDir(t);
  const home = join(base, 'home');
  const kitDir = join(base, 'kit');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(kitDir, 'workstation'), { recursive: true });
  return { base, home, kitDir };
}

test('mergeHooks adds both hooks and keeps unrelated ones', () => {
  const other = { matcher: 'Write|Edit', hooks: [{ type: 'command', command: '"$HOME/tools/other.sh" hook', timeout: 6 }] };
  const after = mergeHooks({ model: 'x', hooks: { PreToolUse: [structuredClone(other)] } }, RUN);
  assert.equal(after.model, 'x');
  assert.deepEqual(after.hooks.PreToolUse[0], other);
  assert.deepEqual(after.hooks.PreToolUse[1], { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `"${RUN}" pre-write # agent-memory-kit`, timeout: 10 }] });
  assert.deepEqual(after.hooks.SessionStart, [{ hooks: [{ type: 'command', command: `"${RUN}" session-start # agent-memory-kit`, timeout: 20 }] }]);
});

test('mergeHooks is idempotent and replaces entries from an older kit location', () => {
  const once = mergeHooks({}, '/old/place/workstation/run.sh');
  const twice = mergeHooks(structuredClone(once), RUN);
  assert.deepEqual(twice, mergeHooks({}, RUN));
});

test('mergeHooks keeps a group that mixes its own hook with another one', () => {
  const mixed = { matcher: 'Write', hooks: [
    { type: 'command', command: '"/old/run.sh" pre-write # agent-memory-kit', timeout: 10 },
    { type: 'command', command: '"/x/other.sh"', timeout: 5 },
  ] };
  const after = mergeHooks({ hooks: { PreToolUse: [mixed] } }, RUN);
  assert.deepEqual(after.hooks.PreToolUse[0].hooks, [{ type: 'command', command: '"/x/other.sh"', timeout: 5 }]);
  assert.equal(after.hooks.PreToolUse.length, 2);
  assert.ok(HOOK_MARKER.startsWith('#'));
});

test('mergeHooks does not modify its input', () => {
  const input = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'x # agent-memory-kit' }] }] } };
  const copy = structuredClone(input);
  mergeHooks(input, RUN);
  assert.deepEqual(input, copy);
});

test('install records the Node path and preserves other settings', async (t) => {
  const { home, kitDir } = fixture(t);
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }));
  await install({ home, kitDir });
  assert.equal(readFileSync(join(kitDir, 'workstation/node.local.path'), 'utf8').trim(), process.execPath);
  const s = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'));
  assert.equal(s.permissions.defaultMode, 'acceptEdits');
  assert.equal(s.hooks.SessionStart.length, 1);
  await install({ home, kitDir });
  const again = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(again, s);
  assert.deepEqual(readdirSync(join(home, '.claude')), ['settings.json']);
});

test('install keeps the mode of an existing settings file', async (t) => {
  const { home, kitDir } = fixture(t);
  writeFileSync(join(home, '.claude/settings.json'), '{}', { mode: 0o600 });
  await install({ home, kitDir });
  assert.equal(statSync(join(home, '.claude/settings.json')).mode & 0o777, 0o600);
});

test('install leaves an unreadable settings file untouched and fails', async (t) => {
  const { home, kitDir } = fixture(t);
  writeFileSync(join(home, '.claude/settings.json'), '{ not json');
  await assert.rejects(install({ home, kitDir }));
  assert.equal(readFileSync(join(home, '.claude/settings.json'), 'utf8'), '{ not json');
});

test('install creates settings.json when absent and rejects an unsafe kit path', async (t) => {
  const { base, home, kitDir } = fixture(t);
  const emptyHome = join(base, 'empty-home');
  mkdirSync(emptyHome);
  await install({ home: emptyHome, kitDir });
  assert.ok(existsSync(join(emptyHome, '.claude/settings.json')));
  for (const bad of ['/srv/ki"t', '/srv/ki$t', '/srv/ki`t', '/srv/ki\nt', 'relative/kit']) {
    await assert.rejects(install({ home, kitDir: bad }), undefined, bad);
  }
});

test('removeHooks drops only the kit entries and adds no hooks key', () => {
  const other = { matcher: 'Write', hooks: [{ type: 'command', command: '"/x/other.sh"', timeout: 5 }] };
  const installed = mergeHooks({ model: 'x', hooks: { PreToolUse: [structuredClone(other)] } }, RUN);
  assert.deepEqual(removeHooks(installed), { model: 'x', hooks: { PreToolUse: [other] } });
  assert.deepEqual(removeHooks({ model: 'x' }), { model: 'x' });
});

test('install without hooks records the Node path, removes the kit hooks and creates no settings file', async (t) => {
  const { base, home, kitDir } = fixture(t);
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ model: 'x' }));
  await install({ home, kitDir });
  await install({ home, kitDir, hooks: false });
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')), { model: 'x', hooks: {} });
  assert.equal(readFileSync(join(kitDir, 'workstation/node.local.path'), 'utf8').trim(), process.execPath);
  const emptyHome = join(base, 'empty-home');
  mkdirSync(emptyHome);
  await install({ home: emptyHome, kitDir, hooks: false });
  assert.equal(existsSync(join(emptyHome, '.claude')), false);
});

// Codex, Kiro and the launcher.

const CODEX_CMD = 'r="$HOME/.config/agent-memory/run.sh"; [ ! -x "$r" ] || "$r" session-start codex # agent-memory-kit';
const KIRO_CMD = 'r="$HOME/.config/agent-memory/run.sh"; [ ! -x "$r" ] || "$r" session-start kiro # agent-memory-kit';
const OWN_ENTRY = { hooks: [{ type: 'command', command: CODEX_CMD, timeout: 20 }] };

function agentFixture(t, { codex = false, kiro = false } = {}) {
  const f = fixture(t);
  if (codex) mkdirSync(join(f.home, '.codex'));
  if (kiro) mkdirSync(join(f.home, '.kiro'));
  return { ...f, codexFile: join(f.home, '.codex/hooks.json'), kiroFile: join(f.home, '.kiro/hooks/agent-memory-kit.json') };
}

function ownCount(config) {
  return Object.values(config.hooks ?? {})
    .flat()
    .flatMap((g) => g?.hooks ?? [])
    .filter((h) => typeof h?.command === 'string' && h.command.includes(HOOK_MARKER)).length;
}

test('toolCommand is the exact launcher-guarded command', () => {
  assert.equal(LAUNCHER_REL, '.config/agent-memory/run.sh');
  assert.equal(toolCommand('codex'), CODEX_CMD);
  assert.equal(toolCommand('kiro'), KIRO_CMD);
});

test('the hook command is silent without a launcher', (t) => {
  const { base } = fixture(t);
  const home = join(base, 'bare-home');
  mkdirSync(home);
  const r = spawnSync('sh', ['-c', toolCommand('codex')], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('the hook command runs the launcher', (t) => {
  const { base } = fixture(t);
  const home = join(base, 'run-home');
  mkdirSync(join(home, '.config/agent-memory'), { recursive: true });
  writeFileSync(join(home, LAUNCHER_REL), '#!/bin/sh\nprintf "%s" "$*"\n', { mode: 0o755 });
  const r = spawnSync('sh', ['-c', toolCommand('codex')], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'session-start codex');
});

test('launcher is written, executable, and runs the kit launcher', async (t) => {
  const { home, kitDir } = fixture(t);
  for (const hooks of [true, false]) {
    await install({ home, kitDir, hooks });
    const file = join(home, LAUNCHER_REL);
    assert.equal(lstatSync(file).isFile(), true);
    assert.equal(statSync(file).mode & 0o777, 0o755);
    assert.ok(readFileSync(file, 'utf8').startsWith('#!/bin/sh\n'));
    assert.ok(readFileSync(file, 'utf8').includes(`exec "${kitDir}/workstation/run.sh" "$@"\n`));
  }
  assert.equal(statSync(join(home, '.config/agent-memory')).mode & 0o777, 0o700);
});

test('launcher: an existing directory keeps its mode', async (t) => {
  const { home, kitDir } = fixture(t);
  mkdirSync(join(home, '.config/agent-memory'), { recursive: true, mode: 0o755 });
  chmodSync(join(home, '.config/agent-memory'), 0o755);
  await install({ home, kitDir });
  assert.equal(statSync(join(home, '.config/agent-memory')).mode & 0o777, 0o755);
});

test('install returns an empty notices list when there is nothing to say', async (t) => {
  const { home, kitDir } = fixture(t);
  assert.deepEqual(await install({ home, kitDir }), { notices: [] });
});

test('codex: no ~/.codex means nothing is created', async (t) => {
  const { home, kitDir } = fixture(t);
  await install({ home, kitDir });
  assert.equal(existsSync(join(home, '.codex')), false);
});

test('codex: mergeCodexHooks adds one SessionStart entry', () => {
  assert.deepEqual(mergeCodexHooks({}), { hooks: { SessionStart: [OWN_ENTRY] } });
});

test('codex: hooks.json is created when absent', async (t) => {
  const { kitDir, home, codexFile } = agentFixture(t, { codex: true });
  const { notices } = await install({ home, kitDir });
  assert.deepEqual(JSON.parse(readFileSync(codexFile, 'utf8')), mergeCodexHooks({}));
  assert.equal(statSync(codexFile).mode & 0o777, 0o600);
  assert.deepEqual(notices, ['Codex: start a session and run /hooks to trust the new hook; Codex skips it until then.']);
});

test('codex: other hooks are kept and a second run adds nothing', async (t) => {
  const { kitDir, home, codexFile } = agentFixture(t, { codex: true });
  const before = {
    description: 'mine',
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/x/a.sh' }] }],
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '/x/b.sh', timeout: 5 }] }],
      PreToolUse: 'not-an-array',
    },
  };
  writeFileSync(codexFile, JSON.stringify(before), { mode: 0o640 });
  const first = await install({ home, kitDir });
  assert.equal(first.notices.length, 1);
  const after = JSON.parse(readFileSync(codexFile, 'utf8'));
  assert.equal(ownCount(after), 1);
  assert.equal(after.description, 'mine');
  assert.deepEqual(after.hooks.UserPromptSubmit, before.hooks.UserPromptSubmit);
  assert.equal(after.hooks.PreToolUse, 'not-an-array');
  assert.deepEqual(after.hooks.SessionStart[0], before.hooks.SessionStart[0]);
  assert.equal(statSync(codexFile).mode & 0o777, 0o640);
  const old = new Date(2020, 0, 1);
  utimesSync(codexFile, old, old);
  const second = await install({ home, kitDir });
  assert.deepEqual(second.notices, []);
  assert.deepEqual(JSON.parse(readFileSync(codexFile, 'utf8')), after);
  assert.equal(statSync(codexFile).mtimeMs, old.getTime());
});

test('codex: an older entry of this kit is replaced', async (t) => {
  const { kitDir, home, codexFile } = agentFixture(t, { codex: true });
  writeFileSync(codexFile, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '"/old/run.sh" session-start # agent-memory-kit' }] }] } }));
  await install({ home, kitDir });
  assert.deepEqual(JSON.parse(readFileSync(codexFile, 'utf8')), { hooks: { SessionStart: [OWN_ENTRY] } });
});

test('codex: a symbolic link is never written', async (t) => {
  const { base, kitDir, home, codexFile } = agentFixture(t, { codex: true });
  const targetDir = join(base, 'managed');
  mkdirSync(targetDir);
  const target = join(targetDir, 'hooks.json');
  const text = JSON.stringify({ hooks: { Stop: [] } });
  writeFileSync(target, text);
  symlinkSync(target, codexFile);
  const { notices } = await install({ home, kitDir });
  assert.equal(readFileSync(target, 'utf8'), text);
  assert.equal(lstatSync(codexFile).isSymbolicLink(), true);
  assert.equal(notices.length, 2);
  assert.equal(notices[1], 'Codex: start a session and run /hooks to trust the new hook; Codex skips it until then.');
  assert.ok(notices[0].startsWith(`Codex: ${codexFile} is a symbolic link and was left unchanged. Add this hook to the file it points to:\n`));
  assert.deepEqual(JSON.parse(notices[0].slice(notices[0].indexOf('\n') + 1)), { hooks: { SessionStart: [OWN_ENTRY] } });
  assert.ok(notices[0].includes('\n{\n  "hooks": {'));

  // With the entry already present there is nothing to say.
  writeFileSync(target, JSON.stringify(mergeCodexHooks({})));
  assert.deepEqual((await install({ home, kitDir })).notices, []);

  // With hooks off and the entry present the removal notice is returned.
  const present = readFileSync(target, 'utf8');
  const off = await install({ home, kitDir, hooks: false });
  assert.deepEqual(off.notices, [`Codex: ${codexFile} is a symbolic link and was left unchanged. Remove the agent-memory-kit hook from the file it points to.`]);
  assert.equal(readFileSync(target, 'utf8'), present);

  // With hooks off and no entry there is nothing to say.
  writeFileSync(target, text);
  assert.deepEqual((await install({ home, kitDir, hooks: false })).notices, []);
});

test('codex: a dangling or unparsable symbolic link does not throw', async (t) => {
  const { base, kitDir, home, codexFile } = agentFixture(t, { codex: true });
  symlinkSync(join(base, 'missing.json'), codexFile);
  const dangling = await install({ home, kitDir });
  assert.equal(dangling.notices.length, 2);
  assert.ok(dangling.notices[0].includes('is a symbolic link and was left unchanged. Add this hook'));
  const target = join(base, 'bad.json');
  writeFileSync(target, '{ nope');
  rmSync(codexFile);
  symlinkSync(target, codexFile);
  const bad = await install({ home, kitDir });
  assert.equal(bad.notices.length, 2);
  assert.equal(readFileSync(target, 'utf8'), '{ nope');
  assert.deepEqual((await install({ home, kitDir, hooks: false })).notices, []);
});

test('codex: --no-hooks removes the entry from a regular file and keeps the rest', async (t) => {
  const { kitDir, home, codexFile } = agentFixture(t, { codex: true });
  const other = { hooks: [{ type: 'command', command: '/x/b.sh' }] };
  writeFileSync(codexFile, JSON.stringify({ description: 'mine', hooks: { Stop: [other] } }));
  await install({ home, kitDir });
  const off = await install({ home, kitDir, hooks: false });
  assert.deepEqual(off.notices, []);
  assert.deepEqual(JSON.parse(readFileSync(codexFile, 'utf8')), { description: 'mine', hooks: { Stop: [other] } });
});

test('codex: --no-hooks creates no file', async (t) => {
  const { kitDir, home, codexFile } = agentFixture(t, { codex: true });
  await install({ home, kitDir, hooks: false });
  assert.equal(existsSync(codexFile), false);
});

test('codex: invalid JSON in a regular hooks.json is an error naming the file', async (t) => {
  const { kitDir, home, codexFile } = agentFixture(t, { codex: true });
  writeFileSync(codexFile, '{ nope');
  await assert.rejects(install({ home, kitDir }), (err) => err.message.includes(codexFile));
  assert.equal(readFileSync(codexFile, 'utf8'), '{ nope');
  writeFileSync(codexFile, '[1]');
  await assert.rejects(install({ home, kitDir }), (err) => err.message.includes(codexFile));
});

test('kiro: no ~/.kiro means nothing is created', async (t) => {
  const { kitDir, home } = agentFixture(t);
  await install({ home, kitDir });
  assert.equal(existsSync(join(home, '.kiro')), false);
});

test('kiro: the hook file is a regular file with the expected document', async (t) => {
  const { base, kitDir, home, kiroFile } = agentFixture(t, { kiro: true });
  assert.deepEqual(kiroHookDocument(), {
    version: 'v1',
    hooks: [{
      name: 'agent-memory-session-start',
      description: 'Print the shared-memory indexes at session start.',
      trigger: 'SessionStart',
      action: { type: 'command', command: KIRO_CMD },
      timeout: 20,
    }],
  });
  await install({ home, kitDir });
  assert.deepEqual(JSON.parse(readFileSync(kiroFile, 'utf8')), kiroHookDocument());
  assert.equal(lstatSync(kiroFile).isFile(), true);
  assert.equal(statSync(kiroFile).mode & 0o777, 0o644);

  // A symbolic link is replaced; its target is not touched.
  const target = join(base, 'elsewhere.json');
  writeFileSync(target, 'keep');
  rmSync(kiroFile);
  symlinkSync(target, kiroFile);
  await install({ home, kitDir });
  assert.equal(lstatSync(kiroFile).isFile(), true);
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  assert.deepEqual(JSON.parse(readFileSync(kiroFile, 'utf8')), kiroHookDocument());
});

test('kiro: --no-hooks removes the kit file and leaves another file alone', async (t) => {
  const { kitDir, home, kiroFile } = agentFixture(t, { kiro: true });
  await install({ home, kitDir });
  await install({ home, kitDir, hooks: false });
  assert.equal(existsSync(kiroFile), false);
  writeFileSync(kiroFile, '{"version":"v1","hooks":[]}');
  await install({ home, kitDir, hooks: false });
  assert.equal(readFileSync(kiroFile, 'utf8'), '{"version":"v1","hooks":[]}');
});
