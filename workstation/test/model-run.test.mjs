import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPrompt, fillTemplate, modelArgs, runModel } from '../lib/model-run.mjs';

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

// True while the process runs. A killed process that init has not yet reaped
// is a zombie (state Z) and counts as gone.
function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

// Signal delivery is asynchronous: allow a moment for a killed process to vanish.
async function gone(pid, waitMs = 2000) {
  const deadline = Date.now() + waitMs;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return !alive(pid);
}

// The pid a fake command wrote to `path`, once it is there (null after waitMs). A test that relies on
// a pid file waits for it instead of assuming the fake has run that far.
async function pidFrom(path, waitMs = 10000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(path, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // Not written yet.
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
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
    assert.ok(!text.includes('[[global:'));
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
  // The time limit leaves the fake ample room to start its background process and write both pids.
  const pending = runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 3000 });
  const pids = [await pidFrom(join(dir, 'sh.pid')), await pidFrom(join(dir, 'sleep.pid'))];
  const r = await pending;
  assert.equal(r.ran, false);
  assert.equal(r.stopReason, 'timeout');
  for (const [i, f] of ['sh.pid', 'sleep.pid'].entries()) {
    assert.ok(Number.isInteger(pids[i]) && pids[i] > 0, `${f} was written`);
    assert.equal(await gone(pids[i]), true, `${f} process is gone`);
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
  // The fake installs its trap before it writes its pid; the time limit leaves room for both.
  const started = Date.now();
  const pending = runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 3000 });
  const pid = await pidFrom(join(dir, 'sh.pid'));
  assert.ok(pid, 'the fake wrote its pid, so its trap is in place');
  const r = await pending;
  assert.equal(r.stopReason, 'timeout');
  // SIGTERM is ignored: only SIGKILL after the 5 s grace period ends it.
  assert.ok(Date.now() - started >= 3000 + 5000);
  assert.equal(await gone(pid), true);
});

test('runModel stops the process group when its signal is aborted', async (t) => {
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
  const controller = new AbortController();
  const started = Date.now();
  const pending = runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 60000, signal: controller.signal });
  while (!existsSync(join(dir, 'sleep.pid')) && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  const r = await pending;
  assert.deepEqual(r, { ran: false, stopReason: 'aborted', costUsd: null, turns: null, denials: 0, summary: '', stderrTail: '' });
  assert.ok(Date.now() - started < 10000);
  for (const f of ['sh.pid', 'sleep.pid']) {
    assert.equal(await gone(Number(readFileSync(join(dir, f), 'utf8'))), true, `${f} process is gone`);
  }
});

test('runModel reports aborted even when the stopped process printed a result', async (t) => {
  const dir = tmp(t);
  const command = fakeCommand(
    dir,
    `trap 'echo "{\\"subtype\\":\\"success\\",\\"is_error\\":false}"; exit 0' TERM\necho $$ > "${join(dir, 'sh.pid')}"\nwhile true; do sleep 0.1; done`,
  );
  t.after(() => {
    try {
      process.kill(Number(readFileSync(join(dir, 'sh.pid'), 'utf8')), 'SIGKILL');
    } catch {}
  });
  const controller = new AbortController();
  const pending = runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 60000, signal: controller.signal });
  const started = Date.now();
  while (!existsSync(join(dir, 'sh.pid')) && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  assert.equal((await pending).stopReason, 'aborted');
});

test('runModel with an already aborted signal starts nothing', async (t) => {
  const dir = tmp(t);
  const command = fakeCommand(dir, `touch "${join(dir, 'started')}"`);
  const controller = new AbortController();
  controller.abort();
  const r = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 10000, signal: controller.signal });
  assert.equal(r.ran, false);
  assert.equal(r.stopReason, 'aborted');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(existsSync(join(dir, 'started')), false);
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

test('runModel parses output just below the 1 MB limit', async (t) => {
  const dir = tmp(t);
  const command = fakeCommand(dir, `printf '{"result":"'; head -c 1000000 /dev/zero | tr '\\0' 'a'; printf '"}'`);
  const r = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 20000 });
  assert.equal(r.ran, true);
  assert.equal(r.summary.length, 2000);
});

test('runModel rejects a timeout that is not a positive finite number', async (t) => {
  const dir = tmp(t);
  const marker = join(dir, 'started');
  const command = fakeCommand(dir, `touch "${marker}"\necho '{}'`);
  for (const timeoutMs of [undefined, 0, -5, NaN, Infinity, '100']) {
    const r = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs });
    assert.equal(r.ran, false);
    assert.equal(r.stopReason, 'invalid-timeout');
  }
  assert.equal(existsSync(marker), false);
});

function killPidFile(file) {
  if (!existsSync(file)) return;
  try {
    process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL');
  } catch {}
}

const hasSetsid = spawnSync('setsid', ['true']).status === 0;
const JSON_OK = `{"subtype":"success","is_error":false,"result":"done"}`;

test('runModel resolves promptly when a background process in another session holds the pipe', { skip: hasSetsid ? false : 'setsid is not available' }, async (t) => {
  const dir = tmp(t);
  const pidFile = join(dir, 'bg.pid');
  try {
    const command = fakeCommand(dir, `setsid sleep 30 &\necho $! > "${pidFile}"\necho '${JSON_OK}'`);
    const started = Date.now();
    const r = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 20000 });
    assert.ok(Date.now() - started < 3000, 'resolved without waiting for the background process');
    assert.equal(r.ran, true);
    assert.equal(r.stopReason, 'completed');
    assert.equal(r.summary, 'done');
  } finally {
    killPidFile(pidFile); // before the folder is removed, so the pid file still exists
  }
});

test('runModel resolves within timeout plus grace when another session holds the pipe and there is no result', { skip: hasSetsid ? false : 'setsid is not available' }, async (t) => {
  const dir = tmp(t);
  const pidFile = join(dir, 'bg.pid');
  try {
    const command = fakeCommand(dir, `setsid sleep 30 &\necho $! > "${pidFile}"\nsleep 30`);
    const started = Date.now();
    const r = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 500 });
    assert.ok(Date.now() - started < 500 + 5000 + 1500);
    assert.equal(r.ran, false);
    assert.equal(r.stopReason, 'timeout');
  } finally {
    killPidFile(pidFile); // before the folder is removed, so the pid file still exists
  }
});

test('runModel resolves promptly when a same-group background process holds the pipe', async (t) => {
  const dir = tmp(t);
  const pidFile = join(dir, 'bg.pid');
  try {
    const command = fakeCommand(dir, `sleep 30 &\necho $! > "${pidFile}"\necho '${JSON_OK}'`);
    const started = Date.now();
    const r = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 20000 });
    assert.ok(Date.now() - started < 3000);
    assert.equal(r.ran, true);
    assert.equal(r.stopReason, 'completed');
  } finally {
    killPidFile(pidFile); // before the folder is removed, so the pid file still exists
  }
});

test('fillTemplate throws on an unclosed block or a stray end marker', () => {
  assert.throws(() => fillTemplate('a {{#if x}} b', { x: true }), /if/);
  assert.throws(() => fillTemplate('a {{/if}} b', {}), /if/);
  assert.equal(fillTemplate('a {{#if x}}b{{/if}} {{y}}', { x: 1, y: 'z' }), 'a b z');
});

test('prompts tell the model to scrub credentials already in a changed note', () => {
  const sentence = 'When a note you change already contains one, replace the value with its name and keep the rest of the fact.';
  assert.ok(renderPrompt('extract', { digest: 'd' }).includes(sentence));
  assert.ok(renderPrompt('organize', { hasGlobal: false }).includes(sentence));
});

test('organize prompt exempts retired files and explains global links and merging', () => {
  const off = renderPrompt('organize', { hasGlobal: false });
  const on = renderPrompt('organize', { hasGlobal: true });
  const exempt = 'A retired file is exempt from the rules above: it holds only its MOVED TO line, has no frontmatter and has no line in MEMORY.md.';
  assert.ok(off.includes(exempt));
  assert.ok(on.includes(exempt));
  assert.ok(on.includes('or, when global/ already has a note on the topic, add to that note instead of creating a second one'));
  assert.ok(on.includes('add or update its line in global/MEMORY.md'));
  assert.ok(on.includes('A link from a note in notes/ to a note in global/ is written [[global:name]].'));
  assert.ok(!off.includes('[[global:'));
});

test('m10: runModel keeps the last 64 KB of the client\'s standard error, and prints none of it', async (t) => {
  const dir = tmp(t);
  const command = fakeCommand(dir, [
    `head -c 70000 /dev/zero | tr '\\0' 'e' >&2`,
    `printf 'STDERR-END-MARKER' >&2`,
    `echo '{"subtype":"success","is_error":false}'`,
  ].join('\n'));
  const r = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 10000 });
  assert.equal(r.stopReason, 'completed');
  assert.equal(Buffer.byteLength(r.stderrTail, 'utf8'), 64 * 1024);
  assert.ok(r.stderrTail.endsWith('STDERR-END-MARKER'));
  const quiet = await runModel({ command: fakeCommand(dir, `echo '{"subtype":"success","is_error":false}'`, 'q.sh'), args: [], cwd: dir, env: {}, timeoutMs: 10000 });
  assert.equal(quiet.stderrTail, '');
  const missing = await runModel({ command: join(dir, 'nope'), args: [], cwd: dir, env: {}, timeoutMs: 10000 });
  assert.equal(missing.stderrTail, '');
});

test('runModel with a command that cannot start, a tiny time limit or an abort signal, never throws', async (t) => {
  const dir = tmp(t);
  const command = join(dir, 'does-not-exist');
  const quick = await runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 1 });
  assert.ok(['spawn-failed', 'timeout'].includes(quick.stopReason), quick.stopReason);
  assert.equal(quick.ran, false);
  const controller = new AbortController();
  const pending = runModel({ command, args: [], cwd: dir, env: {}, timeoutMs: 10000, signal: controller.signal });
  controller.abort();
  const aborted = await pending;
  assert.ok(['spawn-failed', 'aborted'].includes(aborted.stopReason), aborted.stopReason);
  assert.equal(aborted.ran, false);
});

test('organize prompt: global/ is a destination only in a project run; a split note names its main target', () => {
  const off = renderPrompt('organize', { hasGlobal: false });
  const on = renderPrompt('organize', { hasGlobal: true });
  const destination = "global/ is a destination only: add a note there, or add to a note that is already there, only for a fact from notes/ that plainly applies to all of the person's projects. Do not retire, split or rename a note that was already in global/, do not remove its line from global/MEMORY.md (rewording its hook is fine), and do not move a note out of global/; those notes are organized in their own run.";
  assert.ok(on.includes(destination));
  assert.ok(!off.includes('destination only'));
  const split = "When a note's content went to several notes, name in its MOVED TO line the note that received the largest part; the other notes need no pointer.";
  assert.ok(on.includes(split));
  assert.ok(off.includes(split));
});

// T1: tuning of the organize prompt.
const OVER = { overLimit: true, indexLines: 127, indexBytes: 31900 };

test('T1: the over-limit block with the current numbers is shown only when the index is over a limit', () => {
  for (const hasGlobal of [true, false]) {
    const over = renderPrompt('organize', { hasGlobal, ...OVER });
    assert.ok(over.includes('MEMORY.md is over its limit now: 127 lines and 31900 bytes, where at most 200 lines and 25,000 bytes are allowed. Bring it within the limit first.'));
    assert.ok(over.includes('Start by shortening the hooks: an index line is `- [Title](file-name.md) — hook`, and the hook is a short phrase that says when to open the note, not a summary of it. Aim for lines of about 120 bytes; text in a non-Latin script takes about three bytes per character.'));
    assert.ok(over.includes('Only when shorter hooks are not enough, merge closely related notes into one topic note, keeping every fact. Never drop a note from the index.'));
    assert.ok(!over.includes('{{'));
    for (const vars of [{ hasGlobal }, { hasGlobal, overLimit: false, indexLines: 12, indexBytes: 900 }]) {
      const within = renderPrompt('organize', vars);
      assert.ok(!within.includes('over its limit now'));
      assert.ok(!within.includes('{{'));
    }
  }
  assert.ok(!renderPrompt('organize', { hasGlobal: false, ...OVER }).includes('global/'));
});

test('T1: the organize prompt leaves frontmatter alone, never translates, and gives an order of work', () => {
  const on = renderPrompt('organize', { hasGlobal: true });
  const off = renderPrompt('organize', { hasGlobal: false });
  for (const text of [on, off]) {
    assert.ok(text.includes('  name: <a short name for the note>'));
    assert.ok(text.includes('The name need not equal the file name. Leave a frontmatter block that has a name, a description and a type alone: repair only what is missing or broken, and a description that no longer matches its note. Do not rewrite a note only to restyle its frontmatter.'));
    assert.ok(text.includes('In [[…]] links and in MOVED TO lines, a note is named by its file name without .md, not by the name in its frontmatter.'));
    assert.ok(text.includes('Keep every fact in the language it is written in; never translate it, also not when you merge it into a note written in another language. A note may hold more than one language.'));
    assert.ok(text.includes('Work in this order, most important first, so that a run that stops early has finished the earlier items: first, when the index is over its limit, bring it within the limit; then merge .conflict- copies and duplicate notes;'));
    assert.ok(text.includes('last, repair frontmatter and turn relative dates into absolute ones.'));
    assert.ok(!text.includes('name: <the file name without .md>'));
  }
  assert.ok(on.includes('then move the notes that belong in global/;'));
  assert.ok(!off.includes('then move the notes'));
});

test('T2: the repair prompt carries the problems, the reference folder and the whole first task', () => {
  const task = renderPrompt('organize', { hasGlobal: false });
  const text = renderPrompt('repair', { problems: '- notes/b.md: a problem', original: '/w/p/original', task, hasGlobal: false });
  assert.ok(text.includes('- notes/b.md: a problem'));
  assert.ok(text.includes('/w/p/original holds the notes of notes/ as they were before your previous run. It is for reading only'));
  assert.ok(text.endsWith(`${task}\n`) || text.endsWith(task));
  assert.ok(!text.includes('global/'));
  assert.ok(!text.includes('{{'));
  assert.ok(renderPrompt('repair', { problems: 'x', original: 'o', task: 't', hasGlobal: true }).includes('global/ the copy of the global folder'));
  const raw = readFileSync(join(promptsDir, 'repair.md'), 'utf8');
  assert.ok(!raw.includes('/home/') && !raw.includes('@'));
});
