import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { TOOL_BUDGET, buildToolContext, textCost } from '../lib/context.mjs';
import { memoryLinkPath } from '../lib/project.mjs';
import { readStatus } from '../lib/sync-engine.mjs';
import { isolatedEnv, isolateGit, makeRemoteAndClones, sh, tempDir } from './helpers.mjs';

isolateGit();

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const fakeToken = () => 'gh' + 'p_' + 'a'.repeat(36);

// A temporary HOME, a config file, a notes clone and a source repository with a linked worktree.
// The source repository has an `origin` unless `origin` is null.
function fixture(t, { enabled = true, config = {}, origin = 'https://example.com/owner/example-repo' } = {}) {
  const { remote, a } = makeRemoteAndClones(t);
  const tmp = tempDir(t);
  const home = join(tmp, 'home');
  const state = join(tmp, 'state');
  const claudeDir = join(tmp, 'claude');
  mkdirSync(home);
  const configFile = join(tmp, 'config.json');
  if (enabled) {
    writeFileSync(configFile, JSON.stringify({ enabled: true, host: 'alpha', repoDir: a, stateDir: state, claudeDir, ...config }));
  }
  const mainRoot = join(tmp, 'example-repo');
  mkdirSync(mainRoot);
  sh(mainRoot, 'git', ['init', '-b', 'main']);
  sh(mainRoot, 'git', ['config', 'user.name', 'x']);
  sh(mainRoot, 'git', ['config', 'user.email', 'x@example.com']);
  writeFileSync(join(mainRoot, 'f'), 'x');
  sh(mainRoot, 'git', ['add', 'f']);
  sh(mainRoot, 'git', ['commit', '-m', 'init']);
  if (origin !== null) sh(mainRoot, 'git', ['remote', 'add', 'origin', origin]);
  const worktree = join(tmp, 'wt');
  sh(mainRoot, 'git', ['worktree', 'add', '-b', 'topic', worktree]);
  const env = isolatedEnv(home, { AGENT_MEMORY_CONFIG: configFile });
  const link = memoryLinkPath(claudeDir, mainRoot);
  return { remote, repo: a, tmp, home, state, claudeDir, configFile, mainRoot, worktree, env, link };
}

function run(script, input, env, args = []) {
  const stdin = typeof input === 'string' ? input : JSON.stringify(input);
  const file = script.endsWith('.sh') ? join(PKG, script) : process.execPath;
  const argv = script.endsWith('.sh') ? args : [join(PKG, script), ...args];
  return spawnSync(file, argv, { input: stdin, env, encoding: 'utf8' });
}

const errorLines = (state) => readFileSync(join(state, 'hook-errors.log'), 'utf8').trim().split('\n');

test('session-start is silent without a config', (t) => {
  const f = fixture(t, { enabled: false });
  const r = run('session-start.mjs', { cwd: f.worktree }, f.env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(f.state), false);
});

test('session-start links the memory folder and returns context', (t) => {
  const f = fixture(t);
  const r = run('session-start.mjs', { cwd: f.worktree, hook_event_name: 'SessionStart' }, f.env);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /^Shared memory is on\./);
  assert.equal(realpathSync(f.link), realpathSync(join(f.repo, 'projects', basename(f.mainRoot))));
});

test('session-start outside a repository still prints context and links nothing', (t) => {
  const f = fixture(t);
  const r = run('session-start.mjs', { cwd: f.tmp }, f.env);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /not inside a Git repository/);
  assert.equal(existsSync(join(f.claudeDir, 'projects')), false);
});

test('session-start falls back to the process directory when stdin has no cwd', (t) => {
  const f = fixture(t);
  const r = spawnSync(process.execPath, [join(PKG, 'session-start.mjs')], { input: '{}', env: f.env, cwd: f.worktree, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(realpathSync(f.link), realpathSync(join(f.repo, 'projects', 'example-repo')));
});

test('session-start warns when the clone is missing and logs nothing', (t) => {
  const f = fixture(t, { config: { repoDir: '/nonexistent/clone' } });
  const r = run('session-start.mjs', { cwd: f.worktree }, f.env);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /^WARNING: shared memory is enabled but \/nonexistent\/clone is not a usable clone/);
  assert.equal(existsSync(join(f.state, 'hook-errors.log')), false);
});

test('session-start with garbage on stdin exits 0 and logs one line without the input', (t) => {
  const f = fixture(t);
  const r = run('session-start.mjs', 'not json', f.env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const lines = errorLines(f.state);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z session-start /);
  assert.doesNotMatch(lines[0], /not json/);
});

test('session-start logs and stays silent when ensureLink throws', (t) => {
  const f = fixture(t);
  // A file where the project directory must be makes ensureLink fail.
  mkdirSync(join(f.repo, 'projects'));
  writeFileSync(join(f.repo, 'projects', 'example-repo'), 'in the way');
  const r = run('session-start.mjs', { cwd: f.worktree }, f.env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const lines = errorLines(f.state);
  assert.equal(lines.length, 1);
  assert.match(lines[0], / session-start /);
});

test('pre-write denies a secret aimed at the clone through the memory link', (t) => {
  const f = fixture(t);
  run('session-start.mjs', { cwd: f.worktree }, f.env);
  const r = run('pre-write.mjs', { tool_name: 'Write', tool_input: { file_path: join(f.link, 'n.md'), content: fakeToken() } }, f.env);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason,
    'Blocked by the agent-memory secret scan (github-token). Memory notes are synced to a remote repository. Record where the secret is kept instead of its value.');
  assert.doesNotMatch(r.stdout, /ghp_/);
});

test('pre-write scans Edit new_string and each MultiEdit edit', (t) => {
  const f = fixture(t);
  const file = join(f.repo, 'global', 'n.md');
  const edit = run('pre-write.mjs', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: fakeToken() } }, f.env);
  assert.equal(JSON.parse(edit.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const multi = run('pre-write.mjs', { tool_name: 'MultiEdit', tool_input: { file_path: file, edits: [{ old_string: 'a', new_string: 'fine' }, { old_string: 'b', new_string: fakeToken() }] } }, f.env);
  assert.equal(JSON.parse(multi.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('pre-write ignores clean content, other tools and paths outside the clone', (t) => {
  const f = fixture(t);
  run('session-start.mjs', { cwd: f.worktree }, f.env);
  for (const input of [
    { tool_name: 'Write', tool_input: { file_path: join(f.link, 'n.md'), content: 'fine' } },
    { tool_name: 'Bash', tool_input: { command: `echo ${fakeToken()}` } },
    { tool_name: 'Edit', tool_input: { file_path: '/tmp/x.md', new_string: fakeToken() } },
    { tool_name: 'Write', tool_input: { content: fakeToken() } },
  ]) {
    const r = run('pre-write.mjs', input, f.env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

test('pre-write is silent without a config', (t) => {
  const f = fixture(t, { enabled: false });
  const r = run('pre-write.mjs', { tool_name: 'Write', tool_input: { file_path: join(f.repo, 'n.md'), content: fakeToken() } }, f.env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('pre-write with garbage on stdin exits 0 and logs one line', (t) => {
  const f = fixture(t);
  const r = run('pre-write.mjs', '{"tool_name": ', f.env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const lines = errorLines(f.state);
  assert.equal(lines.length, 1);
  assert.match(lines[0], / pre-write /);
});

test('sync.mjs writes status.json and exits 0 on success', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.repo, 'note.md'), 'hello\n');
  const r = run('sync.mjs', '', f.env);
  assert.equal(r.status, 0);
  const status = JSON.parse(readFileSync(join(f.state, 'status.json'), 'utf8'));
  assert.equal(status.ok, true);
  assert.equal(status.pushed, true);
  assert.equal(sh(f.remote, 'git', ['show', 'main:note.md']), 'hello\n');
});

test('sync.mjs exits 1 and records the failure when the remote is unusable', (t) => {
  const f = fixture(t);
  sh(f.repo, 'git', ['remote', 'set-url', 'origin', join(f.tmp, 'no-such-remote.git')]);
  const r = run('sync.mjs', '', f.env);
  assert.equal(r.status, 1);
  const status = JSON.parse(readFileSync(join(f.state, 'status.json'), 'utf8'));
  assert.equal(status.ok, false);
  assert.equal(status.lastSuccess, null);
  assert.ok(status.error);
});

test('sync.mjs with a pull-only bridge whose clone is unusable: exit 0, the failure recorded as fixed text, no AWS', (t) => {
  const f = fixture(t);
  const missing = join(f.tmp, 'agents-missing');
  writeFileSync(f.configFile, JSON.stringify({
    enabled: true, host: 'alpha', repoDir: f.repo, stateDir: f.state, claudeDir: f.claudeDir, bridge: { agentsRepoDir: missing },
  }));
  const r = run('sync.mjs', '', f.env);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const status = JSON.parse(readFileSync(join(f.state, 'status.json'), 'utf8'));
  assert.equal(status.ok, true);
  assert.equal(status.bridge.up, null);
  assert.equal(status.bridge.down.ok, false);
  assert.equal(status.bridge.down.error, 'the agents clone is not usable: the folder does not exist');
  assert.equal(status.bridge.down.lastSuccess, null);
  assert.match(status.bridge.down.failingSince, /^\d{4}-/);
  assert.doesNotMatch(JSON.stringify(status), /agents-missing/);
});

test('sync.mjs with a bridge block but a failed sync: exit 1, the bridge is not run, its record is kept', (t) => {
  const f = fixture(t);
  const missing = join(f.tmp, 'agents-missing');
  writeFileSync(f.configFile, JSON.stringify({
    enabled: true, host: 'alpha', repoDir: f.repo, stateDir: f.state, claudeDir: f.claudeDir, bridge: { agentsRepoDir: missing },
  }));
  assert.equal(run('sync.mjs', '', f.env).status, 0);
  const first = JSON.parse(readFileSync(join(f.state, 'status.json'), 'utf8'));
  sh(f.repo, 'git', ['remote', 'set-url', 'origin', join(f.tmp, 'no-such-remote.git')]);
  assert.equal(run('sync.mjs', '', f.env).status, 1);
  const second = JSON.parse(readFileSync(join(f.state, 'status.json'), 'utf8'));
  assert.equal(second.ok, false);
  assert.deepEqual(second.bridge, first.bridge);
});

// Which files `sync.mjs` loads, recorded by a preloaded module hook (Node's own, no dependency).
function loadedBySync(f, t) {
  const dir = tempDir(t);
  const hook = join(dir, 'record-loads.mjs');
  writeFileSync(hook, [
    "import { appendFileSync } from 'node:fs';",
    "import { registerHooks } from 'node:module';",
    'registerHooks({ load(url, context, next) { appendFileSync(process.env.AM_LOAD_LOG, `${url}\\n`); return next(url, context); } });',
    '',
  ].join('\n'));
  const log = join(dir, 'loads.log');
  const r = spawnSync(process.execPath, ['--import', hook, join(PKG, 'sync.mjs')], {
    input: '', env: { ...f.env, AM_LOAD_LOG: log }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(log, 'utf8');
}

test('sync.mjs loads no bridge module on a machine without a bridge block', (t) => {
  const f = fixture(t);
  const loads = loadedBySync(f, t);
  assert.match(loads, /lib\/sync-engine\.mjs/);
  assert.doesNotMatch(loads, /lib\/bridge(-up|-down)?\.mjs/);
  assert.doesNotMatch(loads, /lib\/(aws|s3)\.mjs/, 'no AWS code is loaded without a bridge block');
  assert.equal('bridge' in JSON.parse(readFileSync(join(f.state, 'status.json'), 'utf8')), false);
});

test('the config and the session-start text load no AWS code', (t) => {
  const dir = tempDir(t);
  const hook = join(dir, 'record-loads.mjs');
  writeFileSync(hook, [
    "import { appendFileSync } from 'node:fs';",
    "import { registerHooks } from 'node:module';",
    'registerHooks({ load(url, context, next) { appendFileSync(process.env.AM_LOAD_LOG, `${url}\\n`); return next(url, context); } });',
    '',
  ].join('\n'));
  const log = join(dir, 'loads.log');
  const code = `await import(${JSON.stringify(join(PKG, 'lib/config.mjs'))}); await import(${JSON.stringify(join(PKG, 'lib/context.mjs'))});`;
  const r = spawnSync(process.execPath, ['--import', hook, '--input-type=module', '-e', code], { env: { ...process.env, AM_LOAD_LOG: log }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const loads = readFileSync(log, 'utf8');
  assert.match(loads, /lib\/config\.mjs/);
  assert.doesNotMatch(loads, /lib\/(aws|s3)\.mjs/);
});

test('sync.mjs loads the bridge modules when a bridge block is configured', (t) => {
  const f = fixture(t);
  writeFileSync(f.configFile, JSON.stringify({
    enabled: true, host: 'alpha', repoDir: f.repo, stateDir: f.state, claudeDir: f.claudeDir, bridge: { agentsRepoDir: join(f.tmp, 'agents-missing') },
  }));
  assert.match(loadedBySync(f, t), /lib\/bridge\.mjs/);
});

// A copy of the kit whose bridge module is replaced by `source`.
function kitWithBridge(t, source) {
  const kit = join(tempDir(t), 'kit');
  cpSync(PKG, kit, { recursive: true });
  writeFileSync(join(kit, 'lib/bridge.mjs'), source);
  return kit;
}

test('sync.mjs: a bridge module that cannot be loaded, or a wrapper that throws, is reported and recorded, not silent', (t) => {
  for (const source of [
    'export const nothing = (() => { throw new Error("secret detail of the load failure"); })();\n',
    'export async function bridgeAfterSync() { throw new Error("secret detail of the wrapper"); }\n',
    'export const bridgeAfterSync = 5;\n',
  ]) {
    const f = fixture(t);
    writeFileSync(f.configFile, JSON.stringify({
      enabled: true, host: 'alpha', repoDir: f.repo, stateDir: f.state, claudeDir: f.claudeDir,
      bridge: { up: true, bucket: 'example-bucket', region: 'ap-northeast-1', agentsRepoDir: join(f.tmp, 'agents-missing') },
    }));
    const kit = kitWithBridge(t, source);
    const r = spawnSync(process.execPath, [join(kit, 'sync.mjs')], { input: '', env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, 'agent-memory bridge could not run\n');
    const status = JSON.parse(readFileSync(join(f.state, 'status.json'), 'utf8'));
    assert.equal(status.ok, true);
    for (const step of ['up', 'down']) {
      assert.equal(status.bridge[step].ok, false, step);
      assert.equal(status.bridge[step].error, 'bridge could not run', step);
      assert.equal(status.bridge[step].status, null, step);
      assert.equal(status.bridge[step].lastSuccess, null, step);
    }
    assert.doesNotMatch(JSON.stringify(status), /secret detail/);
  }
});

test('sync.mjs: a bridge that could not run records only the steps that are configured', (t) => {
  const f = fixture(t);
  writeFileSync(f.configFile, JSON.stringify({
    enabled: true, host: 'alpha', repoDir: f.repo, stateDir: f.state, claudeDir: f.claudeDir, bridge: { agentsRepoDir: join(f.tmp, 'agents-missing') },
  }));
  const kit = kitWithBridge(t, 'export async function bridgeAfterSync() { throw new Error("x"); }\n');
  const r = spawnSync(process.execPath, [join(kit, 'sync.mjs')], { input: '', env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const status = JSON.parse(readFileSync(join(f.state, 'status.json'), 'utf8'));
  assert.equal(status.bridge.up, null);
  assert.equal(status.bridge.down.error, 'bridge could not run');
});

test('sync.mjs: when the sync itself fails, a bridge that cannot load does not overwrite the kept bridge record', (t) => {
  const f = fixture(t);
  writeFileSync(f.configFile, JSON.stringify({
    enabled: true, host: 'alpha', repoDir: f.repo, stateDir: f.state, claudeDir: f.claudeDir, bridge: { agentsRepoDir: join(f.tmp, 'agents-missing') },
  }));
  assert.equal(run('sync.mjs', '', f.env).status, 0);
  const first = JSON.parse(readFileSync(join(f.state, 'status.json'), 'utf8'));
  sh(f.repo, 'git', ['remote', 'set-url', 'origin', join(f.tmp, 'no-such-remote.git')]);
  const kit = kitWithBridge(t, 'export const nothing = (() => { throw new Error("x"); })();\n');
  const r = spawnSync(process.execPath, [join(kit, 'sync.mjs')], { input: '', env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  const second = JSON.parse(readFileSync(join(f.state, 'status.json'), 'utf8'));
  assert.deepEqual(second.bridge, first.bridge);
});

test('sync.mjs exits 0 and writes nothing when not enabled', (t) => {
  const f = fixture(t, { enabled: false });
  const r = run('sync.mjs', '', f.env);
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(f.state, 'status.json')), false);
});

test('run.sh sync runs under the lock and exits with the sync status', (t) => {
  const f = fixture(t);
  const r = run('run.sh', '', f.env, ['sync']);
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(readFileSync(join(f.state, 'status.json'), 'utf8')).ok, true);
  assert.ok(existsSync(join(f.home, '.local/state/agent-memory/sync.lock')));
  sh(f.repo, 'git', ['remote', 'set-url', 'origin', join(f.tmp, 'no-such-remote.git')]);
  assert.equal(run('run.sh', '', f.env, ['sync']).status, 1);
});

test('run.sh sync exits 0 without running when the lock is held', async (t) => {
  const f = fixture(t);
  const lockDir = join(f.home, '.local/state/agent-memory');
  mkdirSync(lockDir, { recursive: true });
  mkdirSync(f.state, { recursive: true });
  const statusFile = join(f.state, 'status.json');
  writeFileSync(statusFile, '{"sentinel":true}\n');
  const holder = spawn('bash', ['-c', 'exec 9> "$1"; flock 9; echo held; sleep 30', 'holder', join(lockDir, 'sync.lock')], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const before = statSync(statusFile).mtimeMs;
  const r = run('run.sh', '', f.env, ['sync']);
  assert.equal(r.status, 0);
  assert.equal(readFileSync(statusFile, 'utf8'), '{"sentinel":true}\n');
  assert.equal(statSync(statusFile).mtimeMs, before);
});

test('run.sh runs the hooks and rejects an unknown mode', (t) => {
  const f = fixture(t);
  const r = run('run.sh', { cwd: f.worktree }, f.env, ['session-start']);
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /^Shared memory is on\./);
  assert.equal(run('run.sh', '', f.env, ['bogus']).status, 2);
});

test('run.sh hooks exit 0 silently when no Node binary can be found', (t) => {
  const f = fixture(t);
  const bin = join(f.tmp, 'bin');
  mkdirSync(bin);
  symlinkSync(spawnSync('which', ['dirname'], { encoding: 'utf8' }).stdout.trim(), join(bin, 'dirname'));
  const launcher = join(f.tmp, 'launcher');
  mkdirSync(launcher);
  copyFileSync(join(PKG, 'run.sh'), join(launcher, 'run.sh'));
  const noNode = { ...f.env, PATH: bin };
  for (const mode of ['session-start', 'pre-write']) {
    const r = spawnSync('/bin/bash', [join(launcher, 'run.sh'), mode], { input: '{}', env: noNode, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

test('run.sh is committed executable', () => {
  assert.ok((statSync(join(PKG, 'run.sh')).mode & 0o111) !== 0);
});

// A second repository named like the first one, with its own origin.
function secondRepo(t, tmp, origin) {
  const root = join(tmp, 'other', 'example-repo');
  mkdirSync(root, { recursive: true });
  sh(root, 'git', ['init']);
  sh(root, 'git', ['remote', 'add', 'origin', origin]);
  return root;
}

test('session-start binds the project folder and links', (t) => {
  const f = fixture(t, { origin: 'https://example.com/a/example-repo' });
  const r = run('session-start.mjs', { cwd: f.worktree }, f.env);
  assert.equal(r.status, 0);
  assert.equal(readFileSync(join(f.repo, 'projects', 'example-repo', '.project'), 'utf8'), 'example.com/a/example-repo\n');
  assert.equal(realpathSync(f.link), realpathSync(join(f.repo, 'projects', 'example-repo')));
});

test('session-start does not link a second repository with the same name', (t) => {
  const f = fixture(t, { origin: 'https://example.com/a/example-repo' });
  run('session-start.mjs', { cwd: f.worktree }, f.env);
  const other = secondRepo(t, f.tmp, 'https://example.com/b/example-repo');
  const otherLink = memoryLinkPath(f.claudeDir, other);
  mkdirSync(otherLink, { recursive: true });
  writeFileSync(join(otherLink, 'local.md'), 'local note\n');
  const r = run('session-start.mjs', { cwd: other }, f.env);
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext,
    /This repository shares its name with another project in shared memory \(example\.com\/a\/example-repo\), so its memory stays on this machine\./);
  assert.equal(lstatSync(otherLink).isSymbolicLink(), false);
  assert.equal(existsSync(join(f.repo, 'projects', 'example-repo', 'local.md')), false);
  assert.equal(readFileSync(join(f.repo, 'projects', 'example-repo', '.project'), 'utf8'), 'example.com/a/example-repo\n');
});

test('session-start warns when a linked repository has lost its matching remote', (t) => {
  const f = fixture(t, { origin: 'https://example.com/a/example-repo' });
  run('session-start.mjs', { cwd: f.worktree }, f.env);
  sh(f.mainRoot, 'git', ['remote', 'set-url', 'origin', 'https://example.com/b/example-repo']);
  const r = run('session-start.mjs', { cwd: f.worktree }, f.env);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext,
    /WARNING: this repository's remote no longer matches the project its memory is linked to \(example\.com\/a\/example-repo\)\./);
  assert.equal(realpathSync(f.link), realpathSync(join(f.repo, 'projects', 'example-repo')));
});

const contextOf = (r) => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

test('session-start in a repository without origin links nothing and says why', (t) => {
  for (const origin of [null, '/srv/repos/example-repo.git', 'file:///srv/repos/example-repo.git']) {
    const f = fixture(t, { origin });
    const r = run('session-start.mjs', { cwd: f.worktree }, f.env);
    assert.equal(r.status, 0);
    assert.match(contextOf(r), /\nThis repository has no shareable "origin" remote, so its memory stays on this machine\.\n/);
    assert.equal(existsSync(f.link), false);
    assert.equal(existsSync(join(f.repo, 'projects')), false);
    assert.equal(existsSync(join(f.state, 'hook-errors.log')), false);
  }
});

test('session-start leaves the existing memory folder of a repository without origin alone', (t) => {
  const f = fixture(t, { origin: null });
  mkdirSync(f.link, { recursive: true });
  writeFileSync(join(f.link, 'local.md'), 'local note\n');
  const r = run('session-start.mjs', { cwd: f.worktree }, f.env);
  assert.match(contextOf(r), /has no shareable "origin" remote/);
  assert.equal(lstatSync(f.link).isDirectory(), true);
  assert.equal(readFileSync(join(f.link, 'local.md'), 'utf8'), 'local note\n');
  assert.equal(existsSync(join(f.repo, 'projects')), false);
});

test('session-start in a repository whose directory name is not a usable project name says so', (t) => {
  const f = fixture(t);
  const odd = join(f.tmp, 'odd name');
  mkdirSync(odd);
  sh(odd, 'git', ['init', '-q']);
  sh(odd, 'git', ['remote', 'add', 'origin', 'https://example.com/owner/odd-name']);
  const r = run('session-start.mjs', { cwd: odd }, f.env);
  const out = contextOf(r);
  assert.match(out, /\nThis repository's directory name cannot be used as a project name, so its memory stays on this machine\.\n/);
  assert.doesNotMatch(out, /not inside a Git repository/);
  assert.equal(existsSync(join(f.repo, 'projects')), false);
});

function assertToolText(r, f) {
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Shared memory is on\./);
  assert.match(r.stdout, /Project index \(/);
  assert.match(r.stdout, /Global index \(/);
  assert.throws(() => JSON.parse(r.stdout));
  assert.equal(readFileSync(join(f.repo, 'projects', 'example-repo', '.project'), 'utf8'), 'example.com/a/example-repo\n');
  assert.equal(existsSync(f.claudeDir), false);
}

test('session-start codex prints plain text with both indexes', (t) => {
  const f = fixture(t, { origin: 'https://example.com/a/example-repo' });
  mkdirSync(join(f.repo, 'projects', 'example-repo'), { recursive: true });
  writeFileSync(join(f.repo, 'projects', 'example-repo', 'MEMORY.md'), '- [Note](note.md) - a fact\n');
  const r = run('session-start.mjs', { cwd: f.worktree }, f.env, ['codex']);
  assertToolText(r, f);
  assert.match(r.stdout, /- \[Note\]\(note\.md\) - a fact/);
});

test('session-start kiro without stdin JSON uses the process directory', (t) => {
  const f = fixture(t, { origin: 'https://example.com/a/example-repo' });
  const r = spawnSync(process.execPath, [join(PKG, 'session-start.mjs'), 'kiro'], { input: '', env: f.env, cwd: f.worktree, encoding: 'utf8' });
  assertToolText(r, f);
});

test('session-start codex outside a repository', (t) => {
  const f = fixture(t);
  const r = run('session-start.mjs', { cwd: f.tmp }, f.env, ['codex']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /This directory is not inside a Git repository, so it has no project notes\./);
  assert.doesNotMatch(r.stdout, /Project index \(/);
  assert.equal(existsSync(join(f.repo, 'projects')), false);
});

test('session-start codex in a repository without origin', (t) => {
  const f = fixture(t, { origin: null });
  const r = run('session-start.mjs', { cwd: f.worktree }, f.env, ['codex']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /has no shareable "origin" remote/);
  assert.doesNotMatch(r.stdout, /Project index \(/);
  assert.equal(existsSync(join(f.repo, 'projects')), false);
});

test('session-start codex with a name claimed by another repository', (t) => {
  const f = fixture(t, { origin: 'https://example.com/b/example-repo' });
  const marker = join(f.repo, 'projects', 'example-repo', '.project');
  mkdirSync(join(f.repo, 'projects', 'example-repo'), { recursive: true });
  writeFileSync(marker, 'example.com/a/example-repo\n');
  const r = run('session-start.mjs', { cwd: f.worktree }, f.env, ['codex']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Shared memory is on\./);
  assert.match(r.stdout, /shares its name with another project in shared memory \(example\.com\/a\/example-repo\)/);
  assert.doesNotMatch(r.stdout, /Project index \(/);
  assert.equal(readFileSync(marker, 'utf8'), 'example.com/a/example-repo\n');
});

test('session-start codex on a machine that is not enabled', (t) => {
  const f = fixture(t, { enabled: false });
  const r = run('session-start.mjs', { cwd: f.worktree }, f.env, ['codex']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(f.state), false);
  assert.equal(existsSync(join(f.state, 'hook-errors.log')), false);
});

test('session-start codex in a repository whose directory name is not a usable project name', (t) => {
  const f = fixture(t);
  const odd = join(f.tmp, 'odd name');
  mkdirSync(odd);
  sh(odd, 'git', ['init', '-q']);
  sh(odd, 'git', ['remote', 'add', 'origin', 'https://example.com/owner/odd-name']);
  const r = run('session-start.mjs', { cwd: odd }, f.env, ['codex']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\nThis repository's directory name cannot be used as a project name, so it has no project notes\.\n/);
  assert.doesNotMatch(r.stdout, /Project index \(/);
  assert.equal(existsSync(join(f.repo, 'projects')), false);
  assert.equal(existsSync(join(f.state, 'hook-errors.log')), false);
});

for (const [label, input] of [['stdin that is not JSON', 'not json'], ['JSON without cwd', '{"session_id": "x"}']]) {
  test(`session-start codex with ${label} uses the process directory and logs nothing`, (t) => {
    const f = fixture(t, { origin: 'https://example.com/a/example-repo' });
    const r = spawnSync(process.execPath, [join(PKG, 'session-start.mjs'), 'codex'], { input, env: f.env, cwd: f.worktree, encoding: 'utf8' });
    assertToolText(r, f);
    assert.equal(existsSync(join(f.state, 'hook-errors.log')), false);
  });
}

test('session-start codex writes exactly the text buildToolContext returns, within the budget', (t) => {
  const f = fixture(t);
  const r = run('session-start.mjs', { cwd: f.tmp }, f.env, ['codex']);
  const config = loadConfig(f.env);
  const expected = buildToolContext({ config, status: readStatus(config), project: null, repoOk: true, reason: 'not-a-repository' });
  assert.equal(r.stdout, expected);
  assert.ok(expected.endsWith('\n') && !expected.endsWith('\n\n'));
  assert.ok(textCost(r.stdout) <= TOOL_BUDGET);
});

// stdin is a terminal: the driver must not wait for input. `script` gives the child a pseudo-terminal.
const hasScript = spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;
// Its stdin stays open and silent, so a driver that read the terminal would wait until killed.
function runOnTerminal(f, tool) {
  const cmd = `"${process.execPath}" "${join(PKG, 'session-start.mjs')}" ${tool}`;
  return new Promise((resolve) => {
    const child = spawn('script', ['-qec', cmd, '/dev/null'], { env: f.env, cwd: f.worktree, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout });
    });
  });
}

test('session-start codex does not read a terminal', { skip: !hasScript && 'script is not available' }, async (t) => {
  const f = fixture(t, { origin: 'https://example.com/a/example-repo' });
  const r = await runOnTerminal(f, 'codex');
  assert.equal(r.signal, null);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Shared memory is on\./);
  assert.match(r.stdout, /Project index \(/);
  assert.equal(existsSync(join(f.state, 'hook-errors.log')), false);
});

test('session-start claude on a terminal logs the input error and prints nothing', { skip: !hasScript && 'script is not available' }, async (t) => {
  const f = fixture(t);
  const r = await runOnTerminal(f, 'claude');
  assert.equal(r.signal, null);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  const lines = errorLines(f.state);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /hook input is not valid JSON/);
});

// The host may write or close stdin after the driver has started.
function runWithLateInput(f, args, input, { writeAt = 400, endAt = 400 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(PKG, 'session-start.mjs'), ...args], { env: f.env, cwd: f.tmp, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (status) => resolve({ status, stdout }));
    setTimeout(() => child.stdin.write(input), writeAt);
    setTimeout(() => child.stdin.end(), Math.max(endAt, writeAt));
  });
}

for (const [label, timing] of [['written late', { writeAt: 400, endAt: 400 }], ['written at once and closed late', { writeAt: 0, endAt: 400 }]]) {
  test(`session-start claude reads input ${label}`, async (t) => {
    const f = fixture(t);
    const r = await runWithLateInput(f, [], JSON.stringify({ cwd: f.worktree }), timing);
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /^Shared memory is on\./);
    assert.equal(realpathSync(f.link), realpathSync(join(f.repo, 'projects', 'example-repo')));
    assert.equal(existsSync(join(f.state, 'hook-errors.log')), false);
  });

  test(`session-start codex uses the cwd of input ${label}`, async (t) => {
    const f = fixture(t, { origin: 'https://example.com/a/example-repo' });
    const r = await runWithLateInput(f, ['codex'], JSON.stringify({ cwd: f.worktree }), timing);
    assertToolText(r, f);
    assert.equal(existsSync(join(f.state, 'hook-errors.log')), false);
  });
}

test('session-start with an unknown tool', (t) => {
  const f = fixture(t);
  const r = run('session-start.mjs', { cwd: f.worktree }, f.env, ['vim']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const lines = errorLines(f.state);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /unknown tool/);
});

test('run.sh session-start passes the tool name to the driver', (t) => {
  const f = fixture(t, { origin: 'https://example.com/a/example-repo' });
  const r = run('run.sh', { cwd: f.worktree }, f.env, ['session-start', 'codex']);
  assertToolText(r, f);
});

test('session-start reports a memory folder that could not be linked', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.link, 'sub'), { recursive: true });
  writeFileSync(join(f.link, 'note.md'), 'local\n');
  const r = run('session-start.mjs', { cwd: f.worktree }, f.env);
  assert.equal(r.status, 0);
  assert.match(contextOf(r), /\nThis repository's memory folder could not be linked \(nested-entries\), so its memory stays on this machine\.\n/);
  assert.equal(lstatSync(f.link).isDirectory(), true);
  assert.equal(readFileSync(join(f.link, 'note.md'), 'utf8'), 'local\n');
  assert.equal(existsSync(join(f.repo, 'projects', 'example-repo', 'note.md')), false);
});
