import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { tempDir } from './helpers.mjs';

function setup(t) {
  const dir = tempDir(t);
  const file = join(dir, 'config.json');
  return {
    dir,
    env: { AGENT_MEMORY_CONFIG: file, HOME: dir },
    write: (c) => writeFileSync(file, JSON.stringify(c)),
    writeRaw: (s) => writeFileSync(file, s),
  };
}

test('returns null without a config file', (t) => {
  const { dir } = setup(t);
  assert.equal(loadConfig({ AGENT_MEMORY_CONFIG: join(dir, 'missing.json'), HOME: dir }), null);
});

test('returns null unless enabled is exactly true', (t) => {
  const { env, write } = setup(t);
  write({ enabled: 'yes', host: 'alpha', repoDir: '/x' });
  assert.equal(loadConfig(env), null);
});

test('applies defaults', (t) => {
  const { dir, env, write } = setup(t);
  write({ enabled: true, host: 'alpha', repoDir: '/home/u/agent-memory' });
  assert.deepEqual(loadConfig(env), {
    host: 'alpha', repoDir: '/home/u/agent-memory', repoUrl: null,
    stateDir: join(dir, '.local/state/agent-memory'), claudeDir: join(dir, '.claude'),
    staleAfterSeconds: 600,
  });
});

test('reads the default path under HOME and honors explicit values', (t) => {
  const { dir } = setup(t);
  mkdirSync(join(dir, '.config/agent-memory'), { recursive: true });
  writeFileSync(join(dir, '.config/agent-memory/config.json'), JSON.stringify({
    enabled: true, host: 'beta', repoDir: '/r', repoUrl: 'git@example.com:u/m.git',
    stateDir: '/s', claudeDir: '/c', staleAfterSeconds: 30,
  }));
  assert.deepEqual(loadConfig({ HOME: dir }), {
    host: 'beta', repoDir: '/r', repoUrl: 'git@example.com:u/m.git',
    stateDir: '/s', claudeDir: '/c', staleAfterSeconds: 30,
  });
});

test('rejects a bad host, a relative repoDir and invalid JSON', (t) => {
  const { env, write, writeRaw } = setup(t);
  for (const c of [
    { enabled: true, host: 'Alpha!', repoDir: '/x' },
    { enabled: true, host: 'alpha', repoDir: 'x' },
    { enabled: true, host: 'alpha', repoDir: '/x', stateDir: 'rel' },
    { enabled: true, host: 'alpha', repoDir: '/x', claudeDir: 'rel' },
  ]) {
    write(c);
    assert.equal(loadConfig(env), null);
  }
  writeRaw('{not json');
  assert.equal(loadConfig(env), null);
});
