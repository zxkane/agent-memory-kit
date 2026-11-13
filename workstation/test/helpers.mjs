import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before } from 'node:test';

export function tempDir(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'am-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Variables through which the machine's own Git configuration would reach a test.
const GIT_CONFIG_VARS = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'];

// Environment for a spawned driver or Git command: a private HOME and no system configuration.
export function isolatedEnv(home, extra = {}) {
  return { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', ...extra };
}

// Runs every Git command of this test file with a private HOME and without the system
// configuration, so that a contributor's signing settings, hooks or ignore file cannot change
// a result. Call once at the top level of a test file.
export function isolateGit() {
  const saved = new Map();
  let home;
  before(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'am-home-')));
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = test\n\temail = test@example.com\n');
    for (const name of GIT_CONFIG_VARS) saved.set(name, process.env[name]);
    for (const name of GIT_CONFIG_VARS) delete process.env[name];
    process.env.HOME = home;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });
  after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
}

export function sh(cwd, cmd, args = []) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function configureIdentity(dir, name) {
  sh(dir, 'git', ['config', 'user.name', name]);
  sh(dir, 'git', ['config', 'user.email', `${name}@example.com`]);
}

// A bare remote whose main holds .gitattributes and .gitignore, plus two clones.
export function makeRemoteAndClones(t) {
  const base = tempDir(t);
  const remote = join(base, 'remote.git');
  const seed = join(base, 'seed');
  const a = join(base, 'a');
  const b = join(base, 'b');
  sh(base, 'git', ['init', '--bare', '-b', 'main', remote]);
  sh(base, 'git', ['init', '-b', 'main', seed]);
  configureIdentity(seed, 'seed');
  writeFileSync(join(seed, '.gitattributes'), 'MEMORY.md merge=union\n');
  writeFileSync(join(seed, '.gitignore'), '*.tmp.*\n');
  sh(seed, 'git', ['add', '.gitattributes', '.gitignore']);
  sh(seed, 'git', ['commit', '-m', 'chore: initial']);
  sh(seed, 'git', ['push', remote, 'main']);
  for (const [dir, name] of [[a, 'a'], [b, 'b']]) {
    sh(base, 'git', ['clone', '-b', 'main', remote, dir]);
    configureIdentity(dir, name);
  }
  return { remote, a, b };
}
