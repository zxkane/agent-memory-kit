import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, realpathSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.mjs';
const source = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('macOS setup initializes, clones mirror, preserves hooks, migrates and syncs under another HOME', (t) => {
  const base = realpathSync(tempDir(t)); const home = join(base, 'another home'); const kit = join(home, 'kit'); const bin = join(base, 'bin');
  for (const d of [home, kit, bin]) mkdirSync(d);
  cpSync(join(source, 'setup.sh'), join(kit, 'setup.sh'));
  cpSync(join(source, 'workstation'), join(kit, 'workstation'), { recursive: true });
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Darwin\n');
  writeFileSync(join(bin, 'launchctl'), '#!/bin/sh\necho "$*" >> "$HOME/calls"\n[ "$1" != print ]\n');
  for (const n of ['uname', 'launchctl']) chmodSync(join(bin, n), 0o755);
  const env = { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', AGENT_MEMORY_CONFIG: join(base, 'does-not-exist.json') };
  const run = (cmd, args) => { const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 30000 }); assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); return r; };
  const remote = join(base, 'notes'); const mirror = join(base, 'mirror');
  for (const d of [remote, mirror]) {
    run('git', ['init', '-q', '-b', 'main', d]);
    if (d === mirror) writeFileSync(join(d, '.agent-memory-mirror'), '');
    run('git', ['-C', d, 'add', '.']);
    run('git', ['-C', d, '-c', 'user.name=test', '-c', 'user.email=user@example.com', 'commit', '-q', '--allow-empty', '-m', 'test']);
    run('git', ['-C', d, 'config', 'receive.denyCurrentBranch', 'updateInstead']);
  }
  run('bash', [join(kit, 'setup.sh'), '--dry-run', '--init', 'test-mac', '--repo-url', remote]);
  assert.equal(existsSync(join(home, '.config')), false);
  assert.equal(existsSync(join(home, 'calls')), false);
  mkdirSync(join(home, '.claude')); writeFileSync(join(home, '.claude/settings.json'), '{"hooks":{"Stop":[{"hooks":[{"command":"keep"}]}]}}');
  const originalSettings = readFileSync(join(home, '.claude/settings.json'), 'utf8');
  run('bash', [join(kit, 'setup.sh'), '--init', 'test-mac', '--repo-url', remote, '--prepare']);
  assert.equal(readFileSync(join(home, '.claude/settings.json'), 'utf8'), originalSettings);
  assert.equal(existsSync(join(home, '.config/agent-memory/run.sh')), false);
  assert.equal(existsSync(join(home, 'Library/LaunchAgents')), false);
  run('bash', [join(kit, 'setup.sh'), '--no-enable']);
  const configPath = join(home, '.config/agent-memory/config.json'); const c = JSON.parse(readFileSync(configPath));
  c.bridge = { up: false, down: false, agentsRepoDir: join(home, 'agents'), agentsRepoUrl: mirror };
  writeFileSync(configPath, JSON.stringify(c));
  run('bash', [join(kit, 'setup.sh')]);
  assert.equal(existsSync(join(home, '.config/systemd')), false);
  assert.ok(existsSync(join(home, 'agents/.agent-memory-mirror')));
  assert.ok(readFileSync(join(home, 'calls'), 'utf8').includes('bootstrap'));
  assert.equal(JSON.parse(readFileSync(join(home, '.claude/settings.json'))).hooks.Stop[0].hooks[0].command, 'keep');
  delete env.AGENT_MEMORY_CONFIG;
  run('bash', [join(kit, 'workstation/run.sh'), 'migrate', '--apply']);
  run('bash', [join(kit, 'workstation/run.sh'), 'sync']);
  assert.equal(JSON.parse(readFileSync(join(home, '.local/state/agent-memory/status.json'))).ok, true);
  // A dangling parent symlink must be followed before either clone exists.
  const other = join(base, 'overlap-home'); mkdirSync(other); mkdirSync(join(other, '.config/agent-memory'), { recursive: true });
  symlinkSync(join(other, 'notes/missing'), join(other, 'mirror-parent'));
  const overlap = { enabled: true, host: 'other', repoDir: join(other, 'notes'), repoUrl: remote,
    bridge: { up: false, down: false, agentsRepoDir: join(other, 'mirror-parent/mirror'), agentsRepoUrl: mirror } };
  writeFileSync(join(other, '.config/agent-memory/config.json'), JSON.stringify(overlap)); env.HOME = other;
  const result = run('bash', [join(kit, 'setup.sh'), '--no-enable']);
  assert.match(result.stdout, /overlaps the notes clone/);
  assert.equal(existsSync(join(other, 'notes/missing/mirror')), false);
  const complex = join(base, 'complex-home'); mkdirSync(join(complex, 'base/deep'), { recursive: true });
  mkdirSync(join(complex, '.config/agent-memory'), { recursive: true });
  symlinkSync('base/deep', join(complex, 'alias'));
  symlinkSync('alias/../notes', join(complex, 'mirror-parent'));
  overlap.repoDir = join(complex, 'base/notes'); overlap.bridge.agentsRepoDir = join(complex, 'mirror-parent/mirror');
  writeFileSync(join(complex, '.config/agent-memory/config.json'), JSON.stringify(overlap)); env.HOME = complex;
  const complexResult = run('bash', [join(kit, 'setup.sh'), '--no-enable']);
  assert.match(complexResult.stdout, /overlaps the notes clone/);
  assert.equal(existsSync(join(complex, 'base/notes/mirror')), false);


});
