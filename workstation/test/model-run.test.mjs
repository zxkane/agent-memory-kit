import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPrompt, modelArgs, runModel } from '../lib/model-run.mjs';

const promptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

function tmp(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'model-run-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeCommand(dir, body, name = 'fake.sh') {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---- renderPrompt ----

test('extract prompt contains the digest path twice and no markers', () => {
  const text = renderPrompt('extract', { digest: '/x/digest.md' });
  assert.equal(text.split('/x/digest.md').length - 1, 2);
  assert.ok(!text.includes('{{'));
});

test('organize prompt with hasGlobal true mentions global notes', () => {
  const text = renderPrompt('organize', { hasGlobal: true });
  assert.ok(text.includes('global/MEMORY.md'));
  assert.ok(text.includes('[[global:name]]'));
  assert.ok(!text.includes('{{'));
  assert.ok(!text.includes('{{/if}}'));
});

test('organize prompt with hasGlobal false has no global parts', () => {
  for (const vars of [{ hasGlobal: false }, {}]) {
    const text = renderPrompt('organize', vars);
    assert.ok(!text.includes('global/'));
    assert.ok(!text.includes('{{'));
  }
});

test('an unknown variable throws and names the variable', () => {
  assert.throws(() => renderPrompt('extract', {}), /digest/);
});

test('prompt files contain nothing private', () => {
  for (const kind of ['extract', 'organize']) {
    const text = readFileSync(join(promptsDir, `${kind}.md`), 'utf8');
    assert.ok(!text.includes('/home/'), kind);
    assert.ok(!text.includes('@'), kind);
    assert.ok(!/\d{12}/.test(text), kind);
  }
});

// ---- modelArgs ----

test('modelArgs returns the fixed argument list', () => {
  const args = modelArgs({
    prompt: 'do it',
    model: 'some-model',
    maxTurns: 40,
    maxBudgetUsd: 1.5,
    addDirs: ['/a', '/b'],
  });
  assert.deepEqual(args, [
    '-p', 'do it',
    '--restricted',
    '--tools', 'Read,Write,Edit,Glob,Grep',
    '--permission-mode', 'acceptEdits',
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format', 'json',
    '--model', 'some-model',
    '--max-turns', '40',
    '--max-budget-usd', '1.5',
    '--add-dir', '/a',
    '--add-dir', '/b',
  ]);
});

test('modelArgs with no addDirs adds none', () => {
  const args = modelArgs({ prompt: 'p', model: 'm', maxTurns: 1, maxBudgetUsd: 2, addDirs: [] });
  assert.ok(!args.includes('--add-dir'));
  assert.equal(args.at(-1), '2');
});

// ---- runModel ----

test('runModel reads a success result', async (t) => {
  const dir = tmp(t);
  const long = 'x'.repeat(3000);
  const json = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 13,
    total_cost_usd: 0.0327,
    result: long,
    permission_denials: [{ a: 1 }, { b: 2 }],
    terminal_reason: 'completed',
  });
  writeFileSync(join(dir, 'out.json'), json);
  const command = fakeCommand(dir, `cat "${join(dir, 'out.json')}"`);
  const r = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 10000 });
  assert.equal(r.ran, true);
  assert.equal(r.stopReason, 'completed');
  assert.equal(r.costUsd, 0.0327);
  assert.equal(r.turns, 13);
  assert.equal(r.denials, 2);
  assert.equal(r.summary.length, 2000);
});

test('runModel reports an error subtype', async (t) => {
  const dir = tmp(t);
  const command = fakeCommand(dir, `echo '{"type":"result","is_error":true,"subtype":"error_max_turns","num_turns":5}'`);
  const r = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 10000 });
  assert.equal(r.ran, true);
  assert.equal(r.stopReason, 'error_max_turns');
  assert.equal(r.turns, 5);
  assert.equal(r.costUsd, null);
  assert.equal(r.denials, 0);
  assert.equal(r.summary, '');
});

test('runModel falls back to terminal_reason, then error', async (t) => {
  const dir = tmp(t);
  const a = fakeCommand(dir, `echo '{"is_error":true,"terminal_reason":"aborted"}'`, 'a.sh');
  const b = fakeCommand(dir, `echo '{"is_error":true}'`, 'b.sh');
  const c = fakeCommand(dir, `echo '{"is_error":false,"subtype":"success"}'`, 'c.sh');
  const d = fakeCommand(dir, `echo '{"is_error":true,"subtype":"success"}'`, 'd.sh');
  const opts = { args: [], cwd: dir, env: {}, timeoutMs: 10000 };
  assert.equal((await runModel({ command: a, ...opts })).stopReason, 'aborted');
  assert.equal((await runModel({ command: b, ...opts })).stopReason, 'error');
  assert.equal((await runModel({ command: c, ...opts })).stopReason, 'completed');
  assert.equal((await runModel({ command: d, ...opts })).stopReason, 'error');
});

test('runModel without parsable output is no-result', async (t) => {
  const dir = tmp(t);
  const command = fakeCommand(dir, 'echo garbage; exit 1');
  const r = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 10000 });
  assert.equal(r.ran, false);
  assert.equal(r.stopReason, 'no-result');
  assert.equal(r.costUsd, null);
  assert.equal(r.turns, null);
});

test('runModel with output that is not an object is no-result', async (t) => {
  const dir = tmp(t);
  const command = fakeCommand(dir, 'echo 42');
  const r = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 10000 });
  assert.equal(r.ran, false);
  assert.equal(r.stopReason, 'no-result');
});

test('runModel with a missing command is spawn-failed', async (t) => {
  const dir = tmp(t);
  const r = await runModel({
    command: join(dir, 'does-not-exist'),
    args: [],
    cwd: dir,
    env: {},
    timeoutMs: 10000,
  });
  assert.equal(r.ran, false);
  assert.equal(r.stopReason, 'spawn-failed');
});

test('runModel with a missing cwd is spawn-failed', async (t) => {
  const dir = tmp(t);
  const command = fakeCommand(dir, 'echo {}');
  const r = await runModel({ command, args: [], cwd: join(dir, 'nope'), env: {}, timeoutMs: 10000 });
  assert.equal(r.ran, false);
  assert.equal(r.stopReason, 'spawn-failed');
});

test('runModel kills a process that outlives the timeout', async (t) => {
  const dir = tmp(t);
  const command = fakeCommand(
    dir,
    `echo $$ > "${join(dir, 'sh.pid')}"\nsleep 60 &\necho $! > "${join(dir, 'sleep.pid')}"\nwait`,
  );
  t.after(() => {
    for (const f of ['sh.pid', 'sleep.pid']) {
      const p = join(dir, f);
      if (existsSync(p)) {
        try {
          process.kill(Number(readFileSync(p, 'utf8')), 'SIGKILL');
        } catch {}
      }
    }
  });
  const r = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 700 });
  assert.equal(r.ran, false);
  assert.equal(r.stopReason, 'timeout');
  for (const f of ['sh.pid', 'sleep.pid']) {
    const pid = Number(readFileSync(join(dir, f), 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal(alive(pid), false, `${f} process is gone`);
  }
});

test('runModel escalates to SIGKILL when SIGTERM is ignored', async (t) => {
  const dir = tmp(t);
  const command = fakeCommand(
    dir,
    `trap '' TERM\necho $$ > "${join(dir, 'sh.pid')}"\nwhile true; do sleep 1; done`,
  );
  t.after(() => {
    try {
      process.kill(Number(readFileSync(join(dir, 'sh.pid'), 'utf8')), 'SIGKILL');
    } catch {}
  });
  const started = Date.now();
  const r = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 500 });
  assert.equal(r.stopReason, 'timeout');
  assert.ok(Date.now() - started >= 5000);
  assert.equal(alive(Number(readFileSync(join(dir, 'sh.pid'), 'utf8'))), false);
});

test('runModel passes only the allowed environment', async (t) => {
  const dir = tmp(t);
  const command = fakeCommand(
    dir,
    `printf '{"result":"%s"}' "$(env | cut -d= -f1 | sort | tr '\\n' ' ')"`,
  );
  process.env.MODEL_RUN_TEST_LEAK = 'secret';
  t.after(() => {
    delete process.env.MODEL_RUN_TEST_LEAK;
  });
  const r = await runModel({ command, args: [], cwd: dir, env: { EXTRA_ONE: '1' }, timeoutMs: 10000 });
  assert.equal(r.ran, true);
  const names = new Set(r.summary.split(' ').filter(Boolean));
  assert.ok(names.has('EXTRA_ONE'));
  assert.ok(!names.has('MODEL_RUN_TEST_LEAK'));
  const shellOwn = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
  const allowed = new Set(['HOME', 'PATH', 'LANG', 'TZ', 'EXTRA_ONE']);
  for (const n of names) {
    assert.ok(allowed.has(n) || shellOwn.has(n), `unexpected variable ${n}`);
  }
});

test('runModel runs in the given working directory with the given args', async (t) => {
  const dir = tmp(t);
  const work = join(dir, 'work');
  mkdirSync(work);
  const command = fakeCommand(dir, `printf '{"result":"%s|%s"}' "$(pwd -P)" "$1"`);
  const r = await runModel({ command, args: ['hello'], cwd: work, env: {}, timeoutMs: 10000 });
  assert.equal(r.summary, `${work}|hello`);
});

test('runModel discards output beyond 1 MB', async (t) => {
  const dir = tmp(t);
  const command = fakeCommand(dir, `printf '{"result":"'; head -c 2000000 /dev/zero | tr '\\0' 'a'; printf '"}'`);
  const r = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 20000 });
  assert.equal(r.ran, false);
  assert.equal(r.stopReason, 'no-result');
});

test('runModel does not leave files behind in the work folder', async (t) => {
  const dir = tmp(t);
  const work = join(dir, 'w');
  mkdirSync(work);
  const command = fakeCommand(dir, `echo '{"subtype":"success","is_error":false}'`);
  await runModel({ command, args: [], cwd: work, env: {}, timeoutMs: 10000 });
  assert.deepEqual(readdirSync(work), []);
});
