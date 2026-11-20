import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL_RE, loadConfig } from '../lib/config.mjs';
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
    stateDir: join(dir, '.local/state/agent-memory'), claudeDir: join(dir, '.claude'), codexDir: join(dir, '.codex'),
    staleAfterSeconds: 600, consolidate: null, consolidateProblem: null, bridge: null, bridgeProblem: null, canary: null, canaryProblem: null,
  });
});

test('reads the default path under HOME and honors explicit values', (t) => {
  const { dir } = setup(t);
  mkdirSync(join(dir, '.config/agent-memory'), { recursive: true });
  writeFileSync(join(dir, '.config/agent-memory/config.json'), JSON.stringify({
    enabled: true, host: 'beta', repoDir: '/r', repoUrl: 'git@example.com:u/m.git',
    stateDir: '/s', claudeDir: '/c', codexDir: '/cx', staleAfterSeconds: 30,
  }));
  assert.deepEqual(loadConfig({ HOME: dir }), {
    host: 'beta', repoDir: '/r', repoUrl: 'git@example.com:u/m.git',
    stateDir: '/s', claudeDir: '/c', codexDir: '/cx', staleAfterSeconds: 30, consolidate: null, consolidateProblem: null, bridge: null, bridgeProblem: null, canary: null, canaryProblem: null,
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

test('the Codex folder is codexDir, else an absolute CODEX_HOME, else ~/.codex', (t) => {
  const { dir, env, write } = setup(t);
  write(BASE);
  assert.equal(loadConfig(env).codexDir, join(dir, '.codex'));
  assert.equal(loadConfig({ ...env, CODEX_HOME: '/opt/codex-home' }).codexDir, '/opt/codex-home');
  // A relative CODEX_HOME is not a folder the timer can find: it is ignored, the rest still works.
  assert.equal(loadConfig({ ...env, CODEX_HOME: 'codex-home' }).codexDir, join(dir, '.codex'));
  assert.equal(loadConfig({ ...env, CODEX_HOME: '' }).codexDir, join(dir, '.codex'));
  write({ ...BASE, codexDir: '/srv/codex' });
  assert.equal(loadConfig({ ...env, CODEX_HOME: '/opt/codex-home' }).codexDir, '/srv/codex');
  // Only Extract reads it: a codexDir that is not an absolute path is null, the rest still works.
  for (const codexDir of ['~/.codex', 'rel', 42, '/a\nb']) {
    write({ ...BASE, codexDir });
    const cfg = loadConfig(env);
    assert.equal(cfg.codexDir, null, String(codexDir));
    assert.equal(cfg.repoDir, BASE.repoDir);
  }
});

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
  assert.deepEqual(loadConfig(env).consolidate, { ...block, agents: null, label: null });
});

test('consolidate defaults are filled', (t) => {
  const { env, write } = setup(t);
  write({ ...BASE, consolidate: { command: '/bin/m', model: 'm1' } });
  assert.deepEqual(loadConfig(env).consolidate, {
    command: '/bin/m', model: 'm1', env: {}, extract: null, organize: null,
    maxProjects: 5, maxTranscriptBytes: 200000, maxTurns: 200, maxBudgetUsd: 5, timeoutMinutes: 30, agents: null, label: null,
  });
});

test('an invalid consolidate block gives null without disabling the config', (t) => {
  const { env, write } = setup(t);
  const ok = { command: '/bin/m', model: 'm1' };
  for (const bad of [
    { ...ok, command: 'rel/m' },
    { ...ok, command: undefined },
    { ...ok, command: '/bin/m\nx' },
    { ...ok, command: '/bin/m\u0000x' },
    { ...ok, command: '/bin/m\u007fx' },
    { ...ok, env: { FOO: 'a\nb' } },
    { ...ok, env: { FOO: 'a\u0000b' } },
    { ...ok, model: '' },
    { ...ok, model: 'a b' },
    { ...ok, env: { lower: 'x' } },
    { ...ok, env: { FOO: 1 } },
    { ...ok, extract: 'Mon; rm' },
    { ...ok, extract: 'Mon\n03:00' },
    { ...ok, organize: '' },
    { ...ok, organize: '   ' },
    { ...ok, extract: ' ' },
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

test('F4: an invalid consolidate block names the first field that failed; absent or valid gives null', (t) => {
  const { env, write } = setup(t);
  const ok = { command: '/bin/m', model: 'm1' };
  const cases = [
    [{ ...ok, command: 'rel/m' }, 'command'],
    [{ ...ok, command: undefined }, 'command'],
    [{ ...ok, command: '/bin/m\nx' }, 'command'],
    [{ ...ok, model: '' }, 'model'],
    [{ ...ok, model: 'a b' }, 'model'],
    [{ ...ok, env: { lower: 'x' } }, 'env'],
    [{ ...ok, env: { FOO: 1 } }, 'env'],
    [{ ...ok, env: [] }, 'env'],
    [{ ...ok, extract: 'Mon; rm' }, 'extract'],
    [{ ...ok, organize: '   ' }, 'organize'],
    [{ ...ok, maxProjects: 51 }, 'maxProjects'],
    [{ ...ok, maxTranscriptBytes: 9999 }, 'maxTranscriptBytes'],
    [{ ...ok, maxTurns: 2000 }, 'maxTurns'],
    [{ ...ok, maxBudgetUsd: 200 }, 'maxBudgetUsd'],
    [{ ...ok, timeoutMinutes: 1000 }, 'timeoutMinutes'],
    [{ ...ok, model: 'a b', maxTurns: 2000 }, 'model'],
    ['text', 'consolidate'],
    [[], 'consolidate'],
  ];
  for (const [block, field] of cases) {
    write({ ...BASE, consolidate: block });
    const cfg = loadConfig(env);
    assert.equal(cfg.consolidate, null, field);
    assert.equal(cfg.consolidateProblem, field, JSON.stringify(block));
  }
  write(BASE);
  assert.equal(loadConfig(env).consolidateProblem, null);
  write({ ...BASE, consolidate: null });
  assert.equal(loadConfig(env).consolidateProblem, null);
  write({ ...BASE, consolidate: ok });
  assert.equal(loadConfig(env).consolidateProblem, null);
});

test('m13: the model is checked with MODEL_RE, the rule of the --model option', (t) => {
  const { env, write } = setup(t);
  for (const model of ['-x', 'a\u0001b', 'a\u007fb', 'x'.repeat(301)]) {
    assert.equal(MODEL_RE.test(model), false, model);
    write({ ...BASE, consolidate: { command: '/bin/m', model } });
    assert.equal(loadConfig(env).consolidateProblem, 'model', model);
  }
  for (const model of ['m1', 'vendor.family-1-2', 'name[1m]', 'x'.repeat(300)]) {
    assert.equal(MODEL_RE.test(model), true, model);
    write({ ...BASE, consolidate: { command: '/bin/m', model } });
    assert.equal(loadConfig(env).consolidate.model, model);
  }
});

test('item 4: a key the consolidate block does not know makes it invalid, naming that key', (t) => {
  const { env, write } = setup(t);
  const ok = { command: '/bin/m', model: 'm1' };
  for (const key of ['organise', 'maxBudget', 'Command']) {
    write({ ...BASE, consolidate: { ...ok, [key]: 'x' } });
    const cfg = loadConfig(env);
    assert.equal(cfg.consolidate, null, key);
    assert.equal(cfg.consolidateProblem, key);
  }
  const every = {
    command: '/bin/m', model: 'm1', env: { A_B: 'x' }, extract: 'Sat *-*-* 03:00', organize: 'Sun *-*-* 04:30',
    maxProjects: 2, maxTranscriptBytes: 20000, maxTurns: 20, maxBudgetUsd: 2, timeoutMinutes: 20,
  };
  write({ ...BASE, consolidate: every });
  assert.deepEqual(loadConfig(env).consolidate, { ...every, agents: null, label: null });
  assert.equal(loadConfig(env).consolidateProblem, null);
});

const AGENTS_OK = { bucket: 'example-bucket', region: 'ap-northeast-1' };
const ORGANIZER_ARN = 'arn:aws:iam::123456789012:role/agent-memory-prod-organizer';

test('the agents part of the consolidate block names the bucket of the agent scopes', (t) => {
  const { env, write } = setup(t);
  const ok = { command: '/bin/m', model: 'm1' };
  write({ ...BASE, consolidate: { ...ok, agents: AGENTS_OK } });
  assert.deepEqual(loadConfig(env).consolidate.agents, { ...AGENTS_OK, roleArn: null, credentials: 'instance' });
  const full = { ...AGENTS_OK, roleArn: ORGANIZER_ARN, credentials: 'environment' };
  write({ ...BASE, consolidate: { ...ok, agents: full } });
  assert.deepEqual(loadConfig(env).consolidate.agents, full);
  write({ ...BASE, consolidate: { ...ok, agents: null } });
  assert.equal(loadConfig(env).consolidate.agents, null);
});

test('an invalid agents part makes the consolidate block invalid, naming its field', (t) => {
  const { env, write } = setup(t);
  const ok = { command: '/bin/m', model: 'm1' };
  for (const [agents, problem] of [
    ['bucket', 'agents'],
    [[AGENTS_OK], 'agents'],
    [{}, 'agents.bucket'],
    [{ ...AGENTS_OK, bucket: 'Bad_Bucket' }, 'agents.bucket'],
    [{ ...AGENTS_OK, region: 'tokyo' }, 'agents.region'],
    [{ ...AGENTS_OK, roleArn: 'arn:aws:iam::123456789012:user/someone' }, 'agents.roleArn'],
    [{ ...AGENTS_OK, credentials: 'file' }, 'agents.credentials'],
    [{ ...AGENTS_OK, buckett: 'x' }, 'agents.buckett'],
    [{ ...AGENTS_OK, ['AKIA' + 'ABCDEFGHIJKLMNOP']: 'x' }, 'agents.(an unknown key)'],
  ]) {
    write({ ...BASE, consolidate: { ...ok, agents } });
    const cfg = loadConfig(env);
    assert.equal(cfg.consolidate, null, problem);
    assert.equal(cfg.consolidateProblem, problem);
  }
});

describe('consolidate.label', () => {
  const OK = { command: '/bin/m', model: 'm1' };
  const LABEL = { model: '<model-id>', region: 'us-east-1', inputUsdPerMillion: 1.1, outputUsdPerMillion: 5.5 };
  const parse = (t, label) => {
    const { env, write } = setup(t);
    write({ ...BASE, consolidate: { ...OK, label } });
    return loadConfig(env);
  };

  test('no block means null', (t) => {
    const { env, write } = setup(t);
    write({ ...BASE, consolidate: OK });
    assert.equal(loadConfig(env).consolidate.label, null);
  });

  test('minimal block gets the defaults', (t) => {
    const cfg = parse(t, LABEL);
    assert.equal(cfg.consolidateProblem, null);
    assert.deepEqual(cfg.consolidate.label, {
      ...LABEL, endpoint: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1', credentials: 'instance', roleArn: null,
      tokenFile: null, reasoningEffort: 'low', batchNotes: 19, domainsFile: null, personaFile: null,
    });
  });

  test('every key can be given; a trailing slash of the endpoint is removed', (t) => {
    const full = {
      ...LABEL, endpoint: 'https://example.com/openai/v1/', credentials: 'environment', roleArn: ORGANIZER_ARN,
      reasoningEffort: 'high', batchNotes: 50, domainsFile: '/etc/domains.json', personaFile: '/etc/persona.md',
    };
    const cfg = parse(t, full);
    assert.equal(cfg.consolidateProblem, null);
    assert.deepEqual(cfg.consolidate.label, { ...full, endpoint: 'https://example.com/openai/v1', tokenFile: null });
  });

  test('a token file excludes credentials and roleArn', (t) => {
    const tokenFile = '/home/u/token';
    assert.equal(parse(t, { ...LABEL, tokenFile, credentials: 'instance' }).consolidateProblem, 'label.tokenFile');
    assert.equal(parse(t, { ...LABEL, tokenFile, roleArn: ORGANIZER_ARN }).consolidateProblem, 'label.tokenFile');
    const cfg = parse(t, { ...LABEL, tokenFile });
    assert.equal(cfg.consolidateProblem, null);
    assert.equal(cfg.consolidate.label.credentials, null);
    assert.equal(cfg.consolidate.label.tokenFile, tokenFile);
  });

  test('an invalid field makes the consolidate block invalid, naming it', (t) => {
    const { model: _m, inputUsdPerMillion: _i, outputUsdPerMillion: _o, ...noPrices } = LABEL;
    for (const [label, problem] of [
      ['x', 'label'],
      [[LABEL], 'label'],
      [{ ...LABEL, model: undefined }, 'label.model'],
      [{ ...LABEL, model: '-x' }, 'label.model'],
      [{ ...LABEL, region: 'tokyo' }, 'label.region'],
      [{ ...LABEL, region: undefined }, 'label.region'],
      [{ ...LABEL, endpoint: 'http://x' }, 'label.endpoint'],
      [{ ...LABEL, endpoint: 'https://x.example.com/v1?a=b' }, 'label.endpoint'],
      [{ ...LABEL, endpoint: 'https://x.example.com/v1#h' }, 'label.endpoint'],
      [{ ...LABEL, endpoint: 'https://u:p@x.example.com/v1' }, 'label.endpoint'],
      [{ ...LABEL, endpoint: 'not a url' }, 'label.endpoint'],
      [{ ...LABEL, credentials: 'file' }, 'label.credentials'],
      [{ ...LABEL, roleArn: 'arn:aws:iam::123456789012:user/someone' }, 'label.roleArn'],
      [{ ...LABEL, tokenFile: 'rel/token' }, 'label.tokenFile'],
      [{ ...LABEL, reasoningEffort: 'max' }, 'label.reasoningEffort'],
      [{ ...LABEL, batchNotes: 0 }, 'label.batchNotes'],
      [{ ...LABEL, batchNotes: 51 }, 'label.batchNotes'],
      [{ ...LABEL, batchNotes: 1.5 }, 'label.batchNotes'],
      [{ ...LABEL, inputUsdPerMillion: undefined }, 'label.inputUsdPerMillion'],
      [{ ...LABEL, inputUsdPerMillion: 0 }, 'label.inputUsdPerMillion'],
      [{ ...LABEL, inputUsdPerMillion: 1001 }, 'label.inputUsdPerMillion'],
      [{ ...LABEL, inputUsdPerMillion: '1' }, 'label.inputUsdPerMillion'],
      [{ ...LABEL, outputUsdPerMillion: undefined }, 'label.outputUsdPerMillion'],
      [{ ...LABEL, outputUsdPerMillion: 0 }, 'label.outputUsdPerMillion'],
      [{ ...LABEL, outputUsdPerMillion: 1001 }, 'label.outputUsdPerMillion'],
      [{ ...noPrices, model: '<model-id>', region: 'us-east-1' }, 'label.inputUsdPerMillion'],
      [{ ...LABEL, domainsFile: 'domains.json' }, 'label.domainsFile'],
      [{ ...LABEL, domainsFile: '/a\nb' }, 'label.domainsFile'],
      [{ ...LABEL, personaFile: 'persona.md' }, 'label.personaFile'],
      [{ ...LABEL, labelModel: 'x' }, 'label.labelModel'],
      [{ ...LABEL, ['AKIA' + 'ABCDEFGHIJKLMNOP']: 'x' }, 'label.(an unknown key)'],
    ]) {
      const cfg = parse(t, label);
      assert.equal(cfg.consolidate, null, problem);
      assert.equal(cfg.consolidateProblem, problem);
    }
  });
});

const BRIDGE_OK = {
  bucket: 'example-bucket', region: 'ap-northeast-1', up: true, down: true,
  agentsRepoDir: '/home/u/agent-memory-mirror', agentsRepoUrl: 'https://example.com/agents.git', roleArn: null, credentials: 'instance',
};

test('bridge is null, with no problem, when the block is absent or null', (t) => {
  const { env, write } = setup(t);
  write(BASE);
  assert.deepEqual([loadConfig(env).bridge, loadConfig(env).bridgeProblem], [null, null]);
  write({ ...BASE, bridge: null });
  assert.deepEqual([loadConfig(env).bridge, loadConfig(env).bridgeProblem], [null, null]);
});

test('bridge: a valid block with every field, and the defaults', (t) => {
  const { env, write } = setup(t);
  write({ ...BASE, bridge: BRIDGE_OK });
  assert.deepEqual(loadConfig(env).bridge, BRIDGE_OK);
  assert.equal(loadConfig(env).bridgeProblem, null);
  write({ ...BASE, bridge: { up: true, bucket: 'example-bucket', region: 'ap-northeast-1' } });
  assert.deepEqual(loadConfig(env).bridge, {
    bucket: 'example-bucket', region: 'ap-northeast-1', up: true, down: false, agentsRepoDir: null, agentsRepoUrl: null, roleArn: null, credentials: 'instance',
  });
  write({ ...BASE, bridge: { agentsRepoDir: '/srv/agents' } });
  assert.deepEqual(loadConfig(env).bridge, {
    bucket: null, region: null, up: false, down: false, agentsRepoDir: '/srv/agents', agentsRepoUrl: null, roleArn: null, credentials: 'instance',
  });
  write({ ...BASE, bridge: { up: false } });
  assert.equal(loadConfig(env).bridge.up, false);
});

test('bridge: each broken rule gives no bridge, names the field, and keeps the rest of the config', (t) => {
  const { env, write } = setup(t);
  const ok = { bucket: 'example-bucket', region: 'ap-northeast-1', up: true };
  const cases = [
    [{ ...ok, down: true, agentsRepoDir: '/home/u/agent-memory' }, 'agentsRepoDir'],
    [{ ...ok, down: true, agentsRepoDir: '/home/u/agent-memory/sub' }, 'agentsRepoDir'],
    [{ ...ok, down: true, agentsRepoDir: '/home/u' }, 'agentsRepoDir'],
    [{ ...ok, down: true, agentsRepoDir: '/' }, 'agentsRepoDir'],
    [{ ...ok, down: true, agentsRepoDir: '/home/u/agent-memory/' }, 'agentsRepoDir'],
    [{ ...ok, down: true, agentsRepoDir: 'relative/dir' }, 'agentsRepoDir'],
    [{ ...ok, agentsRepoDir: '/srv/a\nb' }, 'agentsRepoDir'],
    [{ ...ok, down: true }, 'agentsRepoDir'],
    [{ ...ok, bucket: undefined }, 'bucket'],
    [{ ...ok, bucket: 'Example-bucket' }, 'bucket'],
    [{ ...ok, bucket: 'example.bucket' }, 'bucket'],
    [{ ...ok, region: undefined }, 'region'],
    [{ ...ok, region: 'nowhere' }, 'region'],
    [{ ...ok, up: 'true' }, 'up'],
    [{ ...ok, down: 1 }, 'down'],
    [{ ...ok, agentsRepoUrl: '' }, 'agentsRepoUrl'],
    [{ ...ok, agentsRepoUrl: 5 }, 'agentsRepoUrl'],
    [{ ...ok, agentsRepoUrl: '--upload-pack=x' }, 'agentsRepoUrl'],
    [{ ...ok, agentsRepoUrl: 'https://example.com/a b.git' }, 'agentsRepoUrl'],
    [{ ...ok, agentsRepoUrl: 'https://example.com/a\n.git' }, 'agentsRepoUrl'],
    [{ ...ok, agentsRepoUrl: `https://example.com/${'a'.repeat(300)}` }, 'agentsRepoUrl'],
    [{ ...ok, up: null }, 'up'],
    [{ ...ok, down: null }, 'down'],
    [{ ...ok, down: true, agentsRepoDir: '/home/u/other/../agent-memory/sub' }, 'agentsRepoDir'],
    [{ ...ok, down: true, agentsRepoDir: '/home/u/agent-memory//' }, 'agentsRepoDir'],
    [{ ...ok, down: true, agentsRepoDir: '/home/u/agent-memory/x/..' }, 'agentsRepoDir'],
    [{ ...ok, down: true, agentsRepoDir: '/home/u/x/../' }, 'agentsRepoDir'],
    [{ bucket: 'example-bucket' }, 'bridge'],
    [{}, 'bridge'],
    ['text', 'bridge'],
    [[], 'bridge'],
    [{ ...ok, upp: true }, 'upp'],
    [{ ...ok, 'a b': true }, '(an unknown key)'],
  ];
  for (const [block, field] of cases) {
    write({ ...BASE, bridge: block });
    const cfg = loadConfig(env);
    assert.equal(cfg.bridge, null, JSON.stringify(block));
    assert.equal(cfg.bridgeProblem, field, JSON.stringify(block));
    assert.equal(cfg.host, 'alpha');
    assert.equal(cfg.repoDir, '/home/u/agent-memory');
  }
});

test('bridge: a sibling folder with a common name prefix is not inside repoDir', (t) => {
  const { env, write } = setup(t);
  write({ ...BASE, bridge: { down: true, bucket: 'example-bucket', region: 'ap-northeast-1', agentsRepoDir: '/home/u/agent-memory-mirror' } });
  assert.equal(loadConfig(env).bridgeProblem, null);
});

test('bridge: an agentsRepoDir with .. segments that resolves outside repoDir is accepted', (t) => {
  const { env, write } = setup(t);
  write({ ...BASE, bridge: { down: true, bucket: 'example-bucket', region: 'ap-northeast-1', agentsRepoDir: '/home/u/x/../agents/' } });
  assert.equal(loadConfig(env).bridgeProblem, null);
});

// ---- canary block ----

const CANARY_OK = { stage: 'prod', region: 'ap-northeast-1', schedule: '*-*-* *:00:00', roleArn: null, credentials: 'instance' };

test('canary is null, with no problem, when the block is absent or null', (t) => {
  const { env, write } = setup(t);
  write(BASE);
  assert.deepEqual([loadConfig(env).canary, loadConfig(env).canaryProblem], [null, null]);
  write({ ...BASE, canary: null });
  assert.deepEqual([loadConfig(env).canary, loadConfig(env).canaryProblem], [null, null]);
});

test('canary: a valid block, with and without a schedule', (t) => {
  const { env, write } = setup(t);
  write({ ...BASE, canary: CANARY_OK });
  assert.deepEqual(loadConfig(env).canary, CANARY_OK);
  assert.equal(loadConfig(env).canaryProblem, null);
  write({ ...BASE, canary: { stage: 'dev-2', region: 'us-east-1' } });
  assert.deepEqual(loadConfig(env).canary, { stage: 'dev-2', region: 'us-east-1', schedule: null, roleArn: null, credentials: 'instance' });
  write({ ...BASE, canary: { stage: 'a'.repeat(32), region: 'eu-central-1', schedule: null } });
  assert.equal(loadConfig(env).canary.schedule, null);
});

test('canary: each broken field gives no canary, names the field, and keeps the rest of the config', (t) => {
  const { env, write } = setup(t);
  const ok = { stage: 'prod', region: 'ap-northeast-1' };
  const cases = [
    [{ ...ok, stage: undefined }, 'stage'],
    [{ ...ok, stage: 'Prod' }, 'stage'],
    [{ ...ok, stage: '' }, 'stage'],
    [{ ...ok, stage: 'a'.repeat(33) }, 'stage'],
    [{ ...ok, stage: 'my_stage' }, 'stage'],
    [{ ...ok, stage: 'prod\n' }, 'stage'],
    [{ ...ok, stage: 5 }, 'stage'],
    [{ ...ok, region: undefined }, 'region'],
    [{ ...ok, region: 'nowhere' }, 'region'],
    [{ ...ok, region: 5 }, 'region'],
    [{ ...ok, schedule: '' }, 'schedule'],
    [{ ...ok, schedule: '   ' }, 'schedule'],
    [{ ...ok, schedule: 5 }, 'schedule'],
    [{ ...ok, schedule: 'hourly;rm' }, 'schedule'],
    [{ ...ok, schedule: 'a'.repeat(81) }, 'schedule'],
    [{ ...ok, scheduel: 'hourly' }, 'scheduel'],
    [{ ...ok, 'a b': 1 }, '(an unknown key)'],
    [{ ...ok, ['x'.repeat(65)]: 1 }, '(an unknown key)'],
    ['text', 'canary'],
    [[], 'canary'],
    [7, 'canary'],
  ];
  for (const [block, field] of cases) {
    write({ ...BASE, canary: block });
    const cfg = loadConfig(env);
    assert.equal(cfg.canary, null, JSON.stringify(block));
    assert.equal(cfg.canaryProblem, field, JSON.stringify(block));
    assert.equal(cfg.host, 'alpha');
    assert.equal(cfg.repoDir, '/home/u/agent-memory');
  }
});

test('canary: an invalid block does not disable the other blocks, nor they it', (t) => {
  const { env, write } = setup(t);
  write({ ...BASE, canary: { stage: 'Bad' }, bridge: { agentsRepoDir: '/srv/agents' } });
  const cfg = loadConfig(env);
  assert.equal(cfg.canaryProblem, 'stage');
  assert.equal(cfg.bridge.agentsRepoDir, '/srv/agents');
  write({ ...BASE, canary: CANARY_OK, bridge: { bucket: 'X_bad', up: true, region: 'ap-northeast-1' } });
  const other = loadConfig(env);
  assert.deepEqual(other.canary, CANARY_OK);
  assert.equal(other.bridgeProblem, 'bucket');
});

test('C4: an unknown key that looks like a credential is not echoed', (t) => {
  const { env, write } = setup(t);
  const ok = { command: '/bin/m', model: 'm1' };
  const gitHostToken = 'gh' + 'p_' + 'a'.repeat(36);
  const accessKeyId = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
  for (const key of [gitHostToken, accessKeyId]) {
    write({ ...BASE, consolidate: { ...ok, [key]: 'x' } });
    const cfg = loadConfig(env);
    assert.equal(cfg.consolidate, null);
    assert.equal(cfg.consolidateProblem, '(an unknown key)');
  }
  write({ ...BASE, consolidate: { ...ok, organise: 'x' } });
  assert.equal(loadConfig(env).consolidateProblem, 'organise');
});

test('M-2: only a word-shaped unknown key is echoed', (t) => {
  const { env, write } = setup(t);
  const ok = { command: '/bin/m', model: 'm1' };
  const hex64 = 'ab12'.repeat(16);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const base62 = Array.from({ length: 40 }, (_, i) => alphabet[(i * 7 + 3) % 62]).join('');
  assert.equal(base62.length, 40);
  for (const key of [hex64, base62, 'organise2']) {
    write({ ...BASE, consolidate: { ...ok, [key]: 'x' } });
    assert.equal(loadConfig(env).consolidateProblem, '(an unknown key)', key);
  }
  for (const key of ['organise', 'max_projects']) {
    write({ ...BASE, consolidate: { ...ok, [key]: 'x' } });
    assert.equal(loadConfig(env).consolidateProblem, key);
  }
});

test('one echo rule for all three blocks: a word is named, a credential-like or other key is not', (t) => {
  const { env, write } = setup(t);
  const gitHostToken = 'gh' + 'p_' + 'a'.repeat(36);
  const accessKeyId = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
  const blocks = {
    consolidate: { command: '/bin/m', model: 'm1' },
    bridge: { bucket: 'example-bucket', region: 'ap-northeast-1', up: true },
    canary: { stage: 'prod', region: 'ap-northeast-1' },
  };
  for (const [name, ok] of Object.entries(blocks)) {
    for (const key of [gitHostToken, accessKeyId, 'organise2', 'ab12'.repeat(16), 'a b']) {
      write({ ...BASE, [name]: { ...ok, [key]: 'x' } });
      assert.equal(loadConfig(env)[`${name}Problem`], '(an unknown key)', `${name} ${key.slice(0, 8)}`);
    }
    write({ ...BASE, [name]: { ...ok, misspelt: 'x' } });
    assert.equal(loadConfig(env)[`${name}Problem`], 'misspelt', name);
  }
});

// ---- roleArn ----

const ROLE_OK = 'arn:aws:iam::123456789012:role/example-bridge';
const ROLE_BAD = [
  '', 5, ['x'], 'arn:aws:iam::12345:role/x', 'arn:aws:iam::123456789012:user/x', 'arn:aws:iam::123456789012:role/',
  `${ROLE_OK}\n`, `${ROLE_OK} x`, 'role/example', 'arn:aws:iam::123456789012:role/a b',
];

test('roleArn: a valid value is kept on the bridge block and on the canary block, null when absent or null', (t) => {
  const { env, write } = setup(t);
  write({ ...BASE, bridge: { ...BRIDGE_OK, roleArn: ROLE_OK }, canary: { stage: 'prod', region: 'ap-northeast-1', roleArn: ROLE_OK } });
  const cfg = loadConfig(env);
  assert.deepEqual([cfg.bridge.roleArn, cfg.bridgeProblem, cfg.canary.roleArn, cfg.canaryProblem], [ROLE_OK, null, ROLE_OK, null]);
  write({ ...BASE, bridge: { ...BRIDGE_OK, roleArn: null }, canary: { stage: 'prod', region: 'ap-northeast-1', roleArn: null } });
  const empty = loadConfig(env);
  assert.deepEqual([empty.bridge.roleArn, empty.canary.roleArn], [null, null]);
});

test('roleArn: a bad value makes the block invalid with the problem roleArn', (t) => {
  const { env, write } = setup(t);
  for (const roleArn of ROLE_BAD) {
    write({ ...BASE, bridge: { ...BRIDGE_OK, roleArn } });
    assert.deepEqual([loadConfig(env).bridge, loadConfig(env).bridgeProblem], [null, 'roleArn'], JSON.stringify(roleArn));
    write({ ...BASE, canary: { stage: 'prod', region: 'ap-northeast-1', roleArn } });
    assert.deepEqual([loadConfig(env).canary, loadConfig(env).canaryProblem], [null, 'roleArn'], JSON.stringify(roleArn));
  }
});

test('roleArn: a pull-only bridge block may carry one', (t) => {
  const { env, write } = setup(t);
  write({ ...BASE, bridge: { agentsRepoDir: '/srv/agents', roleArn: ROLE_OK } });
  assert.equal(loadConfig(env).bridge.roleArn, ROLE_OK);
});

// ---- credentials source ----

test('bridge and canary: credentials is "instance" or "environment", "instance" by default', (t) => {
  const { env, write } = setup(t);
  const bridge = { up: true, bucket: 'example-bucket', region: 'ap-northeast-1' };
  const canary = { stage: 'prod', region: 'ap-northeast-1' };
  write({ ...BASE, bridge, canary });
  assert.deepEqual([loadConfig(env).bridge.credentials, loadConfig(env).canary.credentials], ['instance', 'instance']);
  write({ ...BASE, bridge: { ...bridge, credentials: 'environment' }, canary: { ...canary, credentials: 'environment' } });
  let cfg = loadConfig(env);
  assert.deepEqual([cfg.bridge.credentials, cfg.canary.credentials, cfg.bridgeProblem, cfg.canaryProblem], ['environment', 'environment', null, null]);
  write({ ...BASE, bridge: { ...bridge, credentials: 'instance' }, canary: { ...canary, credentials: 'instance' } });
  cfg = loadConfig(env);
  assert.deepEqual([cfg.bridge.credentials, cfg.canary.credentials], ['instance', 'instance']);
  // A pull-only block takes the field too.
  write({ ...BASE, bridge: { agentsRepoDir: '/srv/agents', credentials: 'environment' } });
  assert.equal(loadConfig(env).bridge.credentials, 'environment');
});

test('bridge and canary: any other credentials value makes the block invalid and names the field', (t) => {
  const { env, write } = setup(t);
  const bridge = { up: true, bucket: 'example-bucket', region: 'ap-northeast-1' };
  const canary = { stage: 'prod', region: 'ap-northeast-1' };
  for (const value of ['Environment', 'env', 'imds', '', null, true, 5, ['environment'], {}]) {
    write({ ...BASE, bridge: { ...bridge, credentials: value } });
    assert.deepEqual([loadConfig(env).bridge, loadConfig(env).bridgeProblem], [null, 'credentials'], JSON.stringify(value));
    write({ ...BASE, canary: { ...canary, credentials: value } });
    assert.deepEqual([loadConfig(env).canary, loadConfig(env).canaryProblem], [null, 'credentials'], JSON.stringify(value));
  }
  // An unknown key is still invalid next to a valid credentials field.
  write({ ...BASE, bridge: { ...bridge, credentials: 'environment', upp: true } });
  assert.equal(loadConfig(env).bridgeProblem, 'upp');
  write({ ...BASE, canary: { ...canary, credentials: 'environment', scheduel: 'hourly' } });
  assert.equal(loadConfig(env).canaryProblem, 'scheduel');
});
