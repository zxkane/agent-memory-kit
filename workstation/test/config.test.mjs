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
    staleAfterSeconds: 600, consolidate: null,
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
    stateDir: '/s', claudeDir: '/c', staleAfterSeconds: 30, consolidate: null,
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

const BASE = { enabled: true, host: 'alpha', repoDir: '/home/u/agent-memory' };

test('consolidate is null when the block is absent', (t) => {
  const { env, write } = setup(t);
  write(BASE);
  assert.equal(loadConfig(env).consolidate, null);
});

test('consolidate block is returned with given values', (t) => {
  const { env, write } = setup(t);
  const block = {
    command: '/usr/local/bin/model', model: 'big-model', env: { FOO_BAR: 'x' },
    extract: 'Mon *-*-* 03:00:00', organize: 'Sun *-*-* 04:30', maxProjects: 7,
    maxTranscriptBytes: 50000, maxTurns: 10, maxBudgetUsd: 1.5, timeoutMinutes: 12,
  };
  write({ ...BASE, consolidate: block });
  assert.deepEqual(loadConfig(env).consolidate, block);
});

test('consolidate defaults are filled', (t) => {
  const { env, write } = setup(t);
  write({ ...BASE, consolidate: { command: '/bin/m', model: 'm1' } });
  assert.deepEqual(loadConfig(env).consolidate, {
    command: '/bin/m', model: 'm1', env: {}, extract: null, organize: null,
    maxProjects: 5, maxTranscriptBytes: 200000, maxTurns: 200, maxBudgetUsd: 5, timeoutMinutes: 30,
  });
});

test('an invalid consolidate block gives null without disabling the config', (t) => {
  const { env, write } = setup(t);
  const ok = { command: '/bin/m', model: 'm1' };
  for (const bad of [
    { ...ok, command: 'rel/m' },
    { ...ok, command: undefined },
    { ...ok, model: '' },
    { ...ok, model: 'a b' },
    { ...ok, env: { lower: 'x' } },
    { ...ok, env: { FOO: 1 } },
    { ...ok, extract: 'Mon; rm' },
    { ...ok, extract: 'Mon\n03:00' },
    { ...ok, organize: '' },
    { ...ok, organize: 'x'.repeat(81) },
    { ...ok, maxProjects: 0 },
    { ...ok, maxProjects: 51 },
    { ...ok, maxProjects: 1.5 },
    { ...ok, maxTranscriptBytes: 9999 },
    { ...ok, maxTurns: 1001 },
    { ...ok, maxBudgetUsd: 0 },
    { ...ok, maxBudgetUsd: 101 },
    { ...ok, timeoutMinutes: 1000 },
    'text',
    [],
  ]) {
    write({ ...BASE, consolidate: bad });
    const cfg = loadConfig(env);
    assert.notEqual(cfg, null);
    assert.equal(cfg.host, 'alpha');
    assert.equal(cfg.repoDir, '/home/u/agent-memory');
    assert.equal(cfg.consolidate, null);
  }
});
