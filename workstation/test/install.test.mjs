import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_MARKER, install, mergeHooks, removeHooks } from '../install.mjs';
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
