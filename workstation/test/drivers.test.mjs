import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memoryLinkPath } from '../lib/project.mjs';
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
