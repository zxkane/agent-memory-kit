import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_MARKER, LAUNCHER_REL, checkInstall, install, kiroHookDocument, mergeCodexHooks, mergeHooks, planInstall, removeHooks, toolCommand } from '../install.mjs';
import { tempDir } from './helpers.mjs';

const RUN = '/srv/kit/workstation/run.sh';
const INSTALL_MJS = join(dirname(fileURLToPath(import.meta.url)), '..', 'install.mjs');
const LINKED = 'is a symbolic link or lies in a linked folder, so it was left unchanged.';

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
    assert.equal(readFileSync(file, 'utf8'), `#!/bin/sh\n# Written by agent-memory-kit setup. A stable path to the kit's launcher.\n[ -x "${kitDir}/workstation/run.sh" ] || exit 0\nexec "${kitDir}/workstation/run.sh" "$@"\n`);
  }
  assert.equal(statSync(join(home, '.config/agent-memory')).mode & 0o777, 0o700);
});

test('launcher: passes its arguments to the kit launcher, and is silent when the kit is gone', async (t) => {
  const { home, kitDir } = fixture(t);
  writeFileSync(join(kitDir, 'workstation/run.sh'), '#!/bin/sh\nprintf "%s" "$*"\n', { mode: 0o755 });
  await install({ home, kitDir });
  const env = { PATH: process.env.PATH, HOME: home };
  const ran = spawnSync(join(home, LAUNCHER_REL), ['session-start', 'codex', HOOK_MARKER], { env, encoding: 'utf8' });
  assert.equal(ran.status, 0);
  assert.equal(ran.stdout, `session-start codex ${HOOK_MARKER}`);
  rmSync(kitDir, { recursive: true });
  const gone = spawnSync(join(home, LAUNCHER_REL), ['session-start', 'codex'], { env, encoding: 'utf8' });
  assert.equal(gone.status, 0);
  assert.equal(gone.stdout, '');
  assert.equal(gone.stderr, '');
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
  assert.ok(notices[0].startsWith(`Codex: ${codexFile} ${LINKED} Add this hook to it:\n`));
  assert.deepEqual(JSON.parse(notices[0].slice(notices[0].indexOf('\n') + 1)), { hooks: { SessionStart: [OWN_ENTRY] } });
  assert.ok(notices[0].includes('\n{\n  "hooks": {'));

  // With the entry already present there is nothing to say.
  writeFileSync(target, JSON.stringify(mergeCodexHooks({})));
  assert.deepEqual((await install({ home, kitDir })).notices, []);

  // With hooks off and the entry present the removal notice is returned.
  const present = readFileSync(target, 'utf8');
  const off = await install({ home, kitDir, hooks: false });
  assert.deepEqual(off.notices, [`Codex: ${codexFile} ${LINKED} Remove the agent-memory-kit hook from it.`]);
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
  assert.ok(dangling.notices[0].includes(`${LINKED} Add this hook`));
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

test('codex: an unexpected shape in a regular hooks.json is an error and the file is untouched', async (t) => {
  const { kitDir, home, codexFile } = agentFixture(t, { codex: true });
  for (const text of ['{"hooks": {"SessionStart": "x"}}', '{"hooks": []}', '{"hooks": "x"}']) {
    writeFileSync(codexFile, text);
    await assert.rejects(install({ home, kitDir }), (err) => err.message.includes(codexFile), text);
    assert.equal(readFileSync(codexFile, 'utf8'), text);
  }
  // With hooks off nothing changes and nothing throws.
  writeFileSync(codexFile, '{"hooks": {"SessionStart": "x"}}');
  assert.deepEqual((await install({ home, kitDir, hooks: false })).notices, []);
  assert.equal(readFileSync(codexFile, 'utf8'), '{"hooks": {"SessionStart": "x"}}');
});

test('codex: a symbolic link to an unexpected shape gets the add-by-hand notice', async (t) => {
  const { base, kitDir, home, codexFile } = agentFixture(t, { codex: true });
  const target = join(base, 'shape.json');
  writeFileSync(target, '{"hooks": {"SessionStart": "x"}}');
  symlinkSync(target, codexFile);
  const { notices } = await install({ home, kitDir });
  assert.ok(notices[0].includes(`${LINKED} Add this hook`));
  assert.equal(readFileSync(target, 'utf8'), '{"hooks": {"SessionStart": "x"}}');
});

// A folder that is a symbolic link is never written through.

const TRUST = 'Codex: start a session and run /hooks to trust the new hook; Codex skips it until then.';
const documentOf = (notice) => JSON.parse(notice.slice(notice.indexOf('\n') + 1));
const files = (dir) => readdirSync(dir, { recursive: true }).sort();

test('codex: a linked ~/.codex folder is never written', async (t) => {
  const { base, kitDir, home, codexFile } = agentFixture(t);
  const managed = join(base, 'dotfiles', 'codex');
  mkdirSync(managed, { recursive: true });
  symlinkSync(managed, join(home, '.codex'));

  const created = await install({ home, kitDir });
  assert.deepEqual(files(managed), []);
  assert.equal(created.notices.length, 2);
  assert.ok(created.notices[0].startsWith(`Codex: ${codexFile} ${LINKED} Add this hook to it:\n`));
  assert.deepEqual(documentOf(created.notices[0]), { hooks: { SessionStart: [OWN_ENTRY] } });
  assert.equal(created.notices[1], TRUST);
  assert.deepEqual((await install({ home, kitDir, hooks: false })).notices, []);
  assert.deepEqual(files(managed), []);

  // An existing file in the linked folder is read, never written.
  const target = join(managed, 'hooks.json');
  const without = JSON.stringify({ hooks: { Stop: [] } });
  writeFileSync(target, without);
  const old = new Date(2020, 0, 1);
  utimesSync(target, old, old);
  assert.equal((await install({ home, kitDir })).notices.length, 2);
  assert.deepEqual((await install({ home, kitDir, hooks: false })).notices, []);
  assert.equal(readFileSync(target, 'utf8'), without);

  const withEntry = JSON.stringify(mergeCodexHooks({}));
  writeFileSync(target, withEntry);
  utimesSync(target, old, old);
  assert.deepEqual((await install({ home, kitDir })).notices, []);
  assert.deepEqual((await install({ home, kitDir, hooks: false })).notices, [`Codex: ${codexFile} ${LINKED} Remove the agent-memory-kit hook from it.`]);
  assert.equal(readFileSync(target, 'utf8'), withEntry);
  assert.equal(statSync(target).mtimeMs, old.getTime());

  // Content that could not be used as a regular file does not throw either.
  writeFileSync(target, '{ nope');
  assert.equal((await install({ home, kitDir })).notices.length, 2);
  assert.equal(readFileSync(target, 'utf8'), '{ nope');
  assert.deepEqual(files(managed), ['hooks.json']);
});

test('kiro: a linked ~/.kiro or ~/.kiro/hooks folder is never written', async (t) => {
  for (const linkedFolder of ['.kiro', '.kiro/hooks']) {
    const { base, kitDir, home, kiroFile } = agentFixture(t);
    const managed = join(base, 'dotfiles');
    mkdirSync(managed);
    if (linkedFolder === '.kiro') {
      symlinkSync(managed, join(home, '.kiro'));
    } else {
      mkdirSync(join(home, '.kiro'));
      symlinkSync(managed, join(home, '.kiro/hooks'));
    }
    const inManaged = linkedFolder === '.kiro' ? join(managed, 'hooks/agent-memory-kit.json') : join(managed, 'agent-memory-kit.json');
    const label = `linked ${linkedFolder}`;

    const first = await install({ home, kitDir });
    assert.deepEqual(files(managed), [], label);
    assert.equal(first.notices.length, 1, label);
    assert.ok(first.notices[0].includes(join(home, '.kiro/hooks')), label);
    assert.ok(first.notices[0].includes('left unchanged'), label);
    assert.ok(first.notices[0].includes('regular file named agent-memory-kit.json'), label);
    assert.deepEqual(documentOf(first.notices[0]), kiroHookDocument(), label);
    assert.deepEqual((await install({ home, kitDir, hooks: false })).notices, [], label);
    assert.deepEqual(files(managed), [], label);

    // A file that holds another document gets the same notice and is not changed.
    mkdirSync(dirname(inManaged), { recursive: true });
    writeFileSync(inManaged, '{"version":"v1","hooks":[]}');
    assert.equal((await install({ home, kitDir })).notices.length, 1, label);
    assert.equal(readFileSync(inManaged, 'utf8'), '{"version":"v1","hooks":[]}', label);

    // The right document in place: nothing to say. With hooks off it is not deleted.
    const right = `${JSON.stringify(kiroHookDocument(), null, 2)}\n`;
    writeFileSync(inManaged, right);
    assert.deepEqual((await install({ home, kitDir })).notices, [], label);
    const off = await install({ home, kitDir, hooks: false });
    assert.equal(off.notices.length, 1, label);
    assert.ok(off.notices[0].includes(kiroFile) && off.notices[0].includes('Remove it by hand'), label);
    assert.equal(readFileSync(inManaged, 'utf8'), right, label);
  }
});

test('a home directory reached through a symbolic link does not count as linked', async (t) => {
  const { base, kitDir, home, codexFile, kiroFile } = agentFixture(t, { codex: true, kiro: true });
  const alias = join(base, 'home-alias');
  symlinkSync(home, alias);
  const { notices } = await install({ home: alias, kitDir });
  assert.deepEqual(notices, [TRUST]);
  assert.deepEqual(JSON.parse(readFileSync(codexFile, 'utf8')), mergeCodexHooks({}));
  assert.deepEqual(JSON.parse(readFileSync(kiroFile, 'utf8')), kiroHookDocument());
  assert.equal(lstatSync(codexFile).isFile(), true);
});

test('kiro: a file that already has the right content is not rewritten', async (t) => {
  const { kitDir, home, kiroFile } = agentFixture(t, { kiro: true });
  await install({ home, kitDir });
  const old = new Date(2020, 0, 1);
  utimesSync(kiroFile, old, old);
  await install({ home, kitDir });
  assert.equal(statSync(kiroFile).mtimeMs, old.getTime());
  writeFileSync(kiroFile, '{}');
  await install({ home, kitDir });
  assert.deepEqual(JSON.parse(readFileSync(kiroFile, 'utf8')), kiroHookDocument());
});

test('codex: null shapes in a regular hooks.json are refused, naming the part that is wrong', async (t) => {
  const { kitDir, home, codexFile } = agentFixture(t, { codex: true });
  for (const [text, part] of [
    ['{"hooks": null}', '"hooks"'],
    ['{"hooks": []}', '"hooks"'],
    ['{"hooks": {"SessionStart": null}}', '"hooks.SessionStart"'],
    ['{"hooks": {"SessionStart": {}}}', '"hooks.SessionStart"'],
  ]) {
    writeFileSync(codexFile, text);
    await assert.rejects(install({ home, kitDir }), (err) => err.message.includes(codexFile) && err.message.includes(part), text);
    assert.equal(readFileSync(codexFile, 'utf8'), text);
  }
});

// checkInstall: every validation install can fail on, before anything is written.

test('checkInstall refuses what install refuses and writes nothing', async (t) => {
  const bad = [
    ['.claude/settings.json', '{ nope'],
    ['.claude/settings.json', '[1]'],
    ['.codex/hooks.json', '{ nope'],
    ['.codex/hooks.json', 'null'],
    ['.codex/hooks.json', '{"hooks": null}'],
    ['.codex/hooks.json', '{"hooks": {"SessionStart": "x"}}'],
  ];
  for (const [rel, text] of bad) {
    const { kitDir, home } = agentFixture(t, { codex: true, kiro: true });
    const file = join(home, rel);
    writeFileSync(file, text);
    const before = files(home);
    assert.throws(() => checkInstall({ home }), (err) => err.message.includes(file), `${rel} ${text}`);
    await assert.rejects(install({ home, kitDir }), (err) => err.message.includes(file));
    assert.deepEqual(files(home), before);
    assert.equal(existsSync(join(kitDir, 'workstation/node.local.path')), false);
    assert.equal(existsSync(join(home, '.config')), false);
    assert.equal(readFileSync(file, 'utf8'), text);
  }
});

test('checkInstall accepts good input, a missing or linked file, and shapes that hooks=false ignores', (t) => {
  const { base, home, codexFile } = agentFixture(t, { codex: true });
  assert.doesNotThrow(() => checkInstall({ home }));
  writeFileSync(codexFile, '{"hooks": {"SessionStart": "x"}}');
  assert.doesNotThrow(() => checkInstall({ home, hooks: false }));
  assert.throws(() => checkInstall({ home, hooks: true }), /hooks\.SessionStart/);
  rmSync(codexFile);
  const target = join(base, 'bad.json');
  writeFileSync(target, '{ nope');
  symlinkSync(target, codexFile);
  assert.doesNotThrow(() => checkInstall({ home }));
  assert.throws(() => checkInstall({ home: 'relative' }), /absolute/);
});

test('checkInstall does not look at a Codex file in a linked folder', (t) => {
  const { base, home } = agentFixture(t);
  const managed = join(base, 'dotfiles');
  mkdirSync(managed);
  writeFileSync(join(managed, 'hooks.json'), '{ nope');
  symlinkSync(managed, join(home, '.codex'));
  assert.doesNotThrow(() => checkInstall({ home }));
});

test('install.mjs --check exits non-zero with the message on stderr and writes nothing', (t) => {
  const { home } = agentFixture(t, { codex: true });
  const env = { PATH: process.env.PATH, HOME: home };
  const ok = spawnSync(process.execPath, [INSTALL_MJS, '--check'], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout + ok.stderr, '');
  const codexFile = join(home, '.codex/hooks.json');
  writeFileSync(codexFile, '{"hooks": {"SessionStart": 1}}');
  const bad = spawnSync(process.execPath, [INSTALL_MJS, '--check'], { env, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.ok(bad.stderr.includes(codexFile));
  const off = spawnSync(process.execPath, [INSTALL_MJS, '--check', '--no-hooks'], { env, encoding: 'utf8' });
  assert.equal(off.status, 0);
  assert.equal(existsSync(join(home, '.config')), false);
  const usage = spawnSync(process.execPath, [INSTALL_MJS, '--bogus'], { env, encoding: 'utf8' });
  assert.notEqual(usage.status, 0);
});

// planInstall: what a dry run reports, decided by the rules install uses.

test('planInstall says what install would do for Codex and Kiro', (t) => {
  const { base, home, codexFile, kiroFile } = agentFixture(t, { codex: true, kiro: true });
  const kiroDir = join(home, '.kiro/hooks');
  assert.deepEqual(planInstall({ home }), [
    `would register the Codex session-start hook (${codexFile})`,
    `would write ${kiroFile}`,
  ]);
  assert.deepEqual(planInstall({ home, hooks: false }), []);

  // With the kit's files present, --no-hooks says what it would remove.
  mkdirSync(kiroDir);
  writeFileSync(codexFile, JSON.stringify(mergeCodexHooks({})));
  writeFileSync(kiroFile, `${JSON.stringify(kiroHookDocument())}\n`);
  assert.deepEqual(planInstall({ home, hooks: false }), [
    `would remove the Codex session-start hook from ${codexFile}`,
    `would remove ${kiroFile}`,
  ]);

  // Linked folders: left unchanged, and what is printed instead.
  const managed = join(base, 'dotfiles');
  mkdirSync(join(managed, 'codex'), { recursive: true });
  mkdirSync(join(managed, 'kiro-hooks'));
  rmSync(join(home, '.codex'), { recursive: true });
  rmSync(kiroDir, { recursive: true });
  symlinkSync(join(managed, 'codex'), join(home, '.codex'));
  symlinkSync(join(managed, 'kiro-hooks'), kiroDir);
  const plan = planInstall({ home });
  assert.equal(plan.length, 2);
  assert.ok(plan[0].startsWith(`would leave ${codexFile} unchanged`) && plan[0].includes('print the hook entry to add'));
  assert.ok(plan[1].startsWith(`would leave ${kiroDir} unchanged`) && plan[1].includes('print the hook document to save there'));
  assert.deepEqual(planInstall({ home, hooks: false }), []);
  writeFileSync(join(managed, 'codex/hooks.json'), JSON.stringify(mergeCodexHooks({})));
  writeFileSync(join(managed, 'kiro-hooks/agent-memory-kit.json'), `${JSON.stringify(kiroHookDocument())}\n`);
  const off = planInstall({ home, hooks: false });
  assert.equal(off.length, 2);
  assert.ok(off[0].startsWith(`would leave ${codexFile} unchanged`) && off[0].includes('remove'));
  assert.ok(off[1].startsWith(`would leave ${kiroFile} unchanged`) && off[1].includes('remove'));
  assert.deepEqual(files(managed), ['codex', 'codex/hooks.json', 'kiro-hooks', 'kiro-hooks/agent-memory-kit.json']);
});
