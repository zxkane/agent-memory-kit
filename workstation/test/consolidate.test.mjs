import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTE_NAME_RE } from '../lib/notes.mjs';
import { runSync } from '../lib/sync-engine.mjs';
import { isolatedEnv, isolateGit, makeRemoteAndClones, sh, tempDir } from './helpers.mjs';

isolateGit();

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_SH = join(PKG, 'run.sh');
const SESSION_PHRASE = 'UNIQUE-SESSION-PHRASE-4711 the staging port is 8443';
const SUMMARY = 'MODEL-SUMMARY-TEXT-0815';
const DAY_MS = 24 * 3600 * 1000;

// A stand-in for the model client. It logs how it was called (and the digest it was given), then
// edits files in its working directory as the test's instruction file says for its scope.
const FAKE = `#!${process.execPath}
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
const cwd = process.cwd();
const scope = basename(cwd) === 'notes' ? basename(dirname(cwd)) : basename(cwd);
const args = process.argv.slice(2);
const addDirs = args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []));
let digest = null;
for (const d of addDirs) { try { digest = readFileSync(join(d, 'digest.md'), 'utf8'); } catch {} }
// The calls made before this one for the same scope: a second call follows the "second" instruction.
let earlier = 0;
try {
  earlier = readFileSync(process.env.FAKE_CALLS, 'utf8').split('\\n').filter(Boolean).filter((l) => JSON.parse(l).scope === scope).length;
} catch {}
const original = join(cwd, basename(cwd) === 'notes' ? '../original' : 'original');
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ scope, cwd, args, digest, pid: process.pid, originalSeen: existsSync(original), originalFiles: existsSync(original) ? readdirSync(original).sort() : [] }) + '\\n');
const all = JSON.parse(readFileSync(process.env.FAKE_INSTRUCTIONS, 'utf8'));
const first = all[scope] ?? all['*'] ?? {};
const ins = earlier > 0 && first.second ? first.second : first;
for (const [from, to] of Object.entries(ins.copies ?? {})) writeFileSync(join(cwd, to), readFileSync(join(cwd, from)));
for (const [rel, text] of Object.entries(ins.writes ?? {})) {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), text);
}
for (const [path, text] of Object.entries(ins.liveWrites ?? {})) writeFileSync(path, text);
// An agent writing through the memory API while the model runs: objects of the fake bucket file.
for (const [key, text] of Object.entries(ins.bucketWrites ?? {})) {
  const bucket = JSON.parse(readFileSync(process.env.FAKE_S3_FILE, 'utf8'));
  bucket[key] = { body: Buffer.from(text).toString('base64'), etag: '"' + createHash('md5').update(text).digest('hex') + '"' };
  writeFileSync(process.env.FAKE_S3_FILE, JSON.stringify(bucket));
}
for (const argv of ins.git ?? []) execFileSync('git', argv, { stdio: 'ignore' });
for (const [rel, target] of Object.entries(ins.links ?? {})) {
  rmSync(join(cwd, rel), { recursive: true, force: true });
  symlinkSync(target, join(cwd, rel));
}
for (const [path, mode] of Object.entries(ins.chmod ?? {})) chmodSync(path.startsWith('/') ? path : join(cwd, path), mode);
if (ins.holdLock) {
  // Takes the lock in a process of its own (it outlives this one), so that the apply step waits.
  const { lock, marker, seconds } = ins.holdLock;
  const holder = spawn('flock', [lock, 'sh', '-c', 'touch "$0"; sleep "$1"', marker, String(seconds)], { detached: true, stdio: 'ignore' });
  writeFileSync(marker + '.pid', String(holder.pid));
  holder.unref();
  for (let i = 0; i < 250 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  if (!existsSync(marker)) process.exit(3);
}
if (ins.sleepMs) await new Promise((resolve) => setTimeout(resolve, ins.sleepMs));
if (ins.stderr) process.stderr.write(ins.stderr);
if (ins.silent) process.exit(1);
const result = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.25, num_turns: 4, result: process.env.FAKE_SUMMARY, ...ins.result };
process.stdout.write(JSON.stringify(result) + '\\n');
`;

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const note = (name, description, body) =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n---\n\n${body}\n`;
const index = (...files) => files.map((f) => `- [${f}](${f}) — about ${f}`).join('\n') + '\n';
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const today = () => new Date().toISOString().slice(0, 10);

// The digest the driver records: SHA-256 over the sorted `name:hash` lines of the note files.
function folderDigest(dir) {
  const lines = readdirSync(dir)
    .filter((n) => NOTE_NAME_RE.test(n) && lstatSync(join(dir, n)).isFile())
    .sort()
    .map((n) => `${n}:${sha(readFileSync(join(dir, n)))}`);
  return sha(lines.join('\n'));
}

// Every file under dir (the .git folder excluded), as one string.
function treeText(dir) {
  let out = '';
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    out += e.isDirectory() ? treeText(p) : `${p}\n${readFileSync(p, 'utf8')}\n`;
  }
  return out;
}

function fixture(t, { consolidate = {}, block = true } = {}) {
  const { remote, a } = makeRemoteAndClones(t);
  const tmp = tempDir(t);
  const home = join(tmp, 'home');
  const state = join(tmp, 'state');
  const claudeDir = join(tmp, 'claude');
  mkdirSync(home);
  mkdirSync(claudeDir);
  const fake = join(tmp, 'fake-model.mjs');
  writeFileSync(fake, FAKE);
  chmodSync(fake, 0o755);
  const instructions = join(tmp, 'instructions.json');
  writeFileSync(instructions, '{}');
  const callsFile = join(tmp, 'calls.jsonl');
  const configFile = join(tmp, 'config.json');
  const env = isolatedEnv(home, { AGENT_MEMORY_CONFIG: configFile, AGENT_MEMORY_LOCK_WAIT_SECONDS: '60' });
  const seedConfig = { host: 'alpha', repoDir: a, stateDir: join(tmp, 'seed-state') };
  const f = {
    remote, repo: a, tmp, home, state, claudeDir, configFile, env,
    setConfig(extra = {}, withBlock = block) {
      const c = { enabled: true, host: 'alpha', repoDir: a, stateDir: state, claudeDir };
      if (withBlock) {
        c.consolidate = {
          command: fake, model: 'test-model',
          env: { FAKE_INSTRUCTIONS: instructions, FAKE_CALLS: callsFile, FAKE_SUMMARY: SUMMARY },
          ...consolidate, ...extra,
        };
      }
      writeFileSync(configFile, JSON.stringify(c));
    },
    instruct: (obj) => writeFileSync(instructions, JSON.stringify(obj)),
    calls: () => (existsSync(callsFile)
      ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    run: (...args) => spawnSync(RUN_SH, ['consolidate', ...args], { env, encoding: 'utf8' }),
    runWith: (extra, ...args) => spawnSync(RUN_SH, ['consolidate', ...args], { env: { ...env, ...extra }, encoding: 'utf8' }),
    seed(files) {
      for (const [rel, text] of Object.entries(files)) write(a, rel, text);
      assert.equal(runSync(seedConfig).ok, true);
    },
    sync: () => runSync(seedConfig),
    stateFile: () => join(state, 'consolidate.json'),
    readState: () => JSON.parse(readFileSync(join(state, 'consolidate.json'), 'utf8')),
    head: () => sh(a, 'git', ['rev-parse', 'HEAD']).trim(),
    subjects: () => sh(a, 'git', ['log', '--format=%s']).trim().split('\n'),
    remoteFiles: () => sh(remote, 'git', ['ls-tree', '-r', '--name-only', 'main']).trim().split('\n'),
    reports: () => (existsSync(join(a, '_reports')) ? readdirSync(join(a, '_reports')).sort() : []),
    workRoot: () => join(state, 'consolidate'),
  };
  f.setConfig();
  return f;
}

// A project `p` whose b.md says what a.md says.
function duplicateProject(f) {
  f.seed({
    'projects/p/MEMORY.md': index('a.md', 'b.md'),
    'projects/p/a.md': note('a', 'Deploy notes', 'Deploys go through the staging stack first.'),
    'projects/p/b.md': note('b', 'Deploy notes', 'Deploys go through the staging stack first.'),
  });
}

const mergeInstruction = () => ({
  p: {
    writes: {
      'notes/a.md': note('a', 'Deploy notes (merged)', 'Deploys go through the staging stack first. Merged from b.'),
      'notes/b.md': 'MOVED TO [[a]]\n',
      'notes/MEMORY.md': index('a.md'),
    },
  },
});

test('organize merges a duplicate, commits it with a report and records the state', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.instruct(mergeInstruction());
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: applied, 3 change\(s\), USD 0\.25/m);
  assert.equal(existsSync(join(f.repo, 'projects/p/b.md')), false);
  assert.ok(!f.remoteFiles().includes('projects/p/b.md'));
  assert.match(readFileSync(join(f.repo, 'projects/p/a.md'), 'utf8'), /Merged from b/);

  const subject = f.subjects()[0];
  assert.match(subject, /^consolidate\(alpha\): organize projects\/p \(\d+ file\(s\)\)$/);
  const files = sh(f.repo, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort();
  const report = `_reports/${today()}-alpha-organize-p.md`;
  assert.deepEqual(files, [report, 'projects/p/MEMORY.md', 'projects/p/a.md', 'projects/p/b.md'].sort());
  assert.equal(sh(f.repo, 'git', ['rev-parse', 'HEAD']), sh(f.remote, 'git', ['rev-parse', 'main']));

  const text = readFileSync(join(f.repo, report), 'utf8');
  assert.match(text, new RegExp(`^# Organize p — ${today()} on alpha$`, 'm'));
  assert.match(text, /^- Model: test-model; turns: 4; cost: USD 0\.25; stopped: completed; denials: 0$/m);
  assert.match(text, /^- Index: 2 lines, \d+ bytes → 1 lines, \d+ bytes$/m);
  assert.match(text, /^- Notes not listed in the index: 0 → 0$/m);
  assert.match(text, /^- Notes: \d+ bytes → \d+ bytes; retired: \d+ bytes$/m);
  assert.match(text, /^- Distinct terms kept: 100% \(\d+ of \d+\)$/m);
  assert.match(text, /^## Changed\n- MEMORY\.md\n- a\.md$/m);
  assert.match(text, /^## Retired\n- b\.md → a\.md$/m);
  assert.doesNotMatch(text, /## Added|## Not applied/);
  assert.doesNotMatch(text + r.stdout, new RegExp(SUMMARY));

  const entry = f.readState().projects.p;
  assert.ok(!Number.isNaN(Date.parse(entry.lastOrganize)));
  assert.equal(entry.organizedDigest, folderDigest(join(f.repo, 'projects/p')));
  assert.deepEqual({ ...entry.lastOutcome, at: undefined },
    { kind: 'organize', at: undefined, outcome: 'applied', stopReason: 'completed', costUsd: 0.25, denials: 0, repairs: 0 });
  assert.equal(statSync(f.stateFile()).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(f.workRoot()), []);

  const [call] = f.calls();
  assert.equal(f.calls().length, 1);
  assert.equal(call.scope, 'p');
  assert.equal(dirname(dirname(call.cwd)), f.workRoot());
  assert.ok(call.args.includes('--model') && call.args[call.args.indexOf('--model') + 1] === 'test-model');
  assert.match(call.args[call.args.indexOf('-p') + 1], /global\/MEMORY\.md/);
  assert.ok(!call.args.includes('--add-dir'));
});

test('organize moves a note to global/: both folders and both indexes change', (t) => {
  const f = fixture(t);
  f.seed({
    'global/MEMORY.md': index('g.md'),
    'global/g.md': note('g', 'General', 'Something general.'),
    'projects/p/MEMORY.md': index('a.md', 'k.md'),
    'projects/p/a.md': note('a', 'Prefers short answers', 'The person prefers short answers.'),
    'projects/p/k.md': note('k', 'Kept', 'Stays here.'),
  });
  f.instruct({
    p: {
      writes: {
        'global/short-answers.md': note('short-answers', 'Prefers short answers', 'The person prefers short answers.'),
        'global/MEMORY.md': index('g.md', 'short-answers.md'),
        'notes/a.md': 'MOVED TO [[global:short-answers]]\n',
        'notes/MEMORY.md': index('k.md'),
      },
    },
  });
  const r = f.run('organize', '--project', 'p');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: applied, 4 change\(s\)/m);
  assert.equal(f.calls().length, 1);
  assert.equal(existsSync(join(f.repo, 'projects/p/a.md')), false);
  assert.match(readFileSync(join(f.repo, 'global/short-answers.md'), 'utf8'), /prefers short answers/);
  assert.equal(readFileSync(join(f.repo, 'global/MEMORY.md'), 'utf8'), index('g.md', 'short-answers.md'));
  assert.equal(readFileSync(join(f.repo, 'projects/p/MEMORY.md'), 'utf8'), index('k.md'));
  assert.ok(f.remoteFiles().includes('global/short-answers.md'));
  const text = readFileSync(join(f.repo, `_reports/${today()}-alpha-organize-p.md`), 'utf8');
  assert.match(text, /^## Added\n- global\/short-answers\.md — Prefers short answers$/m);
  assert.match(text, /^## Changed\n- MEMORY\.md\n- global\/MEMORY\.md$/m);
  assert.match(text, /^## Retired\n- a\.md → global\/short-answers\.md$/m);
  assert.match(text, /^- Index \(global\/\): 1 lines, \d+ bytes → 2 lines, \d+ bytes$/m);
  assert.match(text, /^- Notes \(global\/\): \d+ bytes → \d+ bytes; retired: 0 bytes$/m);
});

test('organize of global works on global/ alone', (t) => {
  const f = fixture(t);
  f.seed({
    'global/MEMORY.md': index('a.md', 'b.md'),
    'global/a.md': note('a', 'Deploy notes', 'Deploys go through the staging stack first.'),
    'global/b.md': note('b', 'Deploy notes', 'Deploys go through the staging stack first.'),
    'projects/p/MEMORY.md': index('k.md'),
    'projects/p/k.md': note('k', 'Kept', 'Stays here.'),
  });
  f.instruct({ global: { writes: { 'notes/b.md': 'MOVED TO [[a]]\n', 'notes/MEMORY.md': index('a.md') } } });
  const r = f.run('organize', '--project', 'global');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize global: applied, 2 change\(s\)/m);
  const [call] = f.calls();
  assert.equal(f.calls().length, 1);
  assert.doesNotMatch(call.args[call.args.indexOf('-p') + 1], /global\/MEMORY\.md|\[\[global:/);
  assert.equal(existsSync(join(f.repo, 'global/b.md')), false);
  assert.match(f.subjects()[0], /^consolidate\(alpha\): organize global \(\d+ file\(s\)\)$/);
  const text = readFileSync(join(f.repo, `_reports/${today()}-alpha-organize-global.md`), 'utf8');
  assert.match(text, /^# Organize global — /m);
  assert.match(text, /^## Retired\n- b\.md → a\.md$/m);
  assert.ok(f.readState().projects.global.organizedDigest);
  assert.equal(f.readState().projects.p, undefined);
});

// True while the process runs; a zombie that is not yet reaped counts as gone.
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

async function waitFor(check, ms = 15000) {
  const deadline = Date.now() + ms;
  let value;
  while (!(value = check()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  return value;
}

// Starts `run.sh consolidate <args>` with a sleeping fake model, waits for the model call, sends
// `signal` to the driver and returns what is left.
async function interrupt(t, f, signal, args) {
  const child = spawn(RUN_SH, ['consolidate', ...args], { env: f.env, stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const exited = new Promise((resolve) => child.once('close', (code, sig) => resolve({ code, signal: sig })));
  let call;
  t.after(() => {
    child.kill('SIGKILL');
    if (call) {
      try { process.kill(-call.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
  call = await waitFor(() => f.calls()[0]);
  assert.ok(call, 'the model was called');
  child.kill(signal);
  const status = await exited;
  return { call, status, stdout };
}

const lockIsFree = (f) => spawnSync('flock', ['-n', join(f.home, '.local/state/agent-memory/consolidate.lock'), 'true']).status === 0;

test('SIGTERM during the model run stops the model and removes the work folder, digest included', async (t) => {
  const f = extractFixture(t);
  f.instruct({ p: { sleepMs: 20000 } });
  const head = f.head();
  const { call, status, stdout } = await interrupt(t, f, 'SIGTERM', ['extract']);
  assert.deepEqual(status, { code: 143, signal: null });
  assert.equal(alive(call.pid), false);
  assert.deepEqual(readdirSync(f.workRoot()), []);
  assert.equal(f.head(), head);
  assert.match(stdout, /^extract p: aborted, nothing applied/m);
  assert.equal(f.readState().projects.p.lastExtract, undefined);
});

test('SIGINT and SIGHUP stop the model, apply nothing and free the lock', async (t) => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGHUP', 129]]) {
    const f = fixture(t);
    duplicateProject(f);
    const instruction = mergeInstruction();
    instruction.p.sleepMs = 20000;
    f.instruct(instruction);
    const head = f.head();
    const { call, status } = await interrupt(t, f, signal, ['organize']);
    assert.deepEqual(status, { code, signal: null }, signal);
    assert.equal(alive(call.pid), false, signal);
    assert.deepEqual(readdirSync(f.workRoot()), [], signal);
    assert.equal(f.head(), head, signal);
    assert.ok(existsSync(join(f.repo, 'projects/p/b.md')), signal);
    assert.ok(lockIsFree(f), signal);
  }
});

test('an interrupted run with --keep keeps its work folder and says so', async (t) => {
  const f = extractFixture(t);
  f.instruct({ p: { sleepMs: 20000 } });
  const { call, status, stdout } = await interrupt(t, f, 'SIGINT', ['extract', '--keep']);
  assert.equal(status.code, 130);
  assert.ok(existsSync(join(dirname(call.cwd), 'input/digest.md')));
  assert.ok(stdout.includes(dirname(call.cwd)));
  assert.match(stdout, /conversation text/);
});

test('a rejected result changes nothing in the clone; organize records the scope as tried', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.instruct({ p: { writes: { 'notes/b.md': 'MOVED TO [[nothere]]\n', 'notes/MEMORY.md': index('a.md') } } });
  const head = f.head();
  const before = treeText(f.repo);
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: rejected, nothing applied \(2 rule violation\(s\)\), USD 0\.50, stopped: completed, one repair run \(2 problem\(s\) found first\)$/m);
  assert.match(r.stdout, /^ {2}- notes\/b\.md: the target note does not exist$/m);
  assert.equal(f.head(), head);
  assert.equal(treeText(f.repo), before);
  assert.deepEqual(f.reports(), []);
  // The same notes would give the same rejection: the scope waits until it changes.
  const entry = f.readState().projects.p;
  assert.ok(!Number.isNaN(Date.parse(entry.lastOrganize)));
  assert.equal(entry.organizedDigest, folderDigest(join(f.repo, 'projects/p')));
  assert.equal(entry.lastOutcome.outcome, 'rejected');
  assert.deepEqual(readdirSync(f.workRoot()), []);
  f.run('organize');
  assert.equal(f.calls().length, 2, 'the first run and its one repair run; the second organize run calls no model');
});

test('a rejected extract keeps its previous lastExtract', (t) => {
  const f = extractFixture(t);
  const before = new Date(Date.now() - 2 * DAY_MS).toISOString();
  mkdirSync(f.state, { recursive: true });
  writeFileSync(f.stateFile(), JSON.stringify({ projects: { p: { lastExtract: before }, h: { lastExtract: before } } }));
  f.instruct({ p: { writes: { 'a.md': '' } } });
  const r = f.run('extract');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^extract p: rejected, nothing applied \(1 rule violation\(s\)\)/m);
  assert.equal(f.readState().projects.p.lastExtract, before);
  assert.notEqual(f.readState().projects.h.lastExtract, before);
});

// A project `p` with a duplicate pair, and a global/ folder that sessions of every project write to.
function duplicateProjectWithGlobal(f) {
  duplicateProject(f);
  f.seed({ 'global/MEMORY.md': index('g.md'), 'global/g.md': note('g', 'General', 'Something general.') });
}

test('F1: a session writing global/ during a project run that does not touch global/ is applied', (t) => {
  const f = fixture(t);
  duplicateProjectWithGlobal(f);
  const g2 = join(f.repo, 'global/g2.md');
  const g2Text = note('g2', 'Written by a session', 'Another project wrote this.');
  const instruction = mergeInstruction();
  instruction.p.liveWrites = { [g2]: g2Text };
  f.instruct(instruction);
  const r = f.run('organize', '--project', 'p');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: applied, 3 change\(s\)/m);
  assert.equal(existsSync(join(f.repo, 'projects/p/b.md')), false);
  assert.equal(readFileSync(g2, 'utf8'), g2Text);
  const files = sh(f.repo, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n');
  assert.ok(!files.includes('global/g2.md'));
  assert.ok(f.remoteFiles().includes('global/g2.md'));
});

test('F1: a session writing global/ while the result adds to or retires into global/ is changed meanwhile', (t) => {
  const edits = {
    add: { 'global/new.md': note('new', 'New', 'A new global note.'), 'global/MEMORY.md': index('g.md', 'new.md') },
    retire: {
      'global/g.md': note('g', 'General', 'Something general. Deploys go through the staging stack first.'),
      'notes/b.md': 'MOVED TO [[global:g]]\n',
      'notes/MEMORY.md': index('a.md'),
    },
  };
  for (const [name, writes] of Object.entries(edits)) {
    const f = fixture(t);
    duplicateProjectWithGlobal(f);
    f.instruct({ p: { writes, liveWrites: { [join(f.repo, 'global/g2.md')]: note('g2', 'S', 'A session wrote this.') } } });
    const r = f.run('organize', '--project', 'p');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^organize p: changed meanwhile, nothing applied/m, name);
    assert.match(r.stdout, /^ {2}- changed meanwhile: global\/g2\.md$/m, name);
    assert.ok(existsSync(join(f.repo, 'projects/p/b.md')), name);
  }
});

test('a note written to the live folder during the run means nothing is applied', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  const live = join(f.repo, 'projects/p/new.md');
  const instruction = mergeInstruction();
  instruction.p.liveWrites = { [live]: note('new', 'Written by a session', 'A session wrote this.') };
  f.instruct(instruction);
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: changed meanwhile, nothing applied, USD 0\.25, stopped: completed$/m);
  assert.match(r.stdout, /^ {2}- changed meanwhile: notes\/new\.md$/m);
  assert.match(readFileSync(live, 'utf8'), /A session wrote this/);
  assert.ok(existsSync(join(f.repo, 'projects/p/b.md')));
  assert.doesNotMatch(readFileSync(join(f.repo, 'projects/p/a.md'), 'utf8'), /Merged from b/);
  assert.ok(!f.subjects().some((s) => s.startsWith('consolidate(')));
  assert.deepEqual(f.reports(), []);
  assert.equal(f.readState().projects.p.lastOrganize, undefined);
});

test('organize picks due scopes only: over-limit, then conflicts, then changed; maxProjects bounds the calls', (t) => {
  const f = fixture(t, { consolidate: { maxProjects: 1 } });
  const lines = Array.from({ length: 201 }, (_, i) => `- [n${i}](n${i}.md) — line ${i}`).join('\n') + '\n';
  f.seed({
    'projects/same/MEMORY.md': index('a.md'),
    'projects/same/a.md': note('a', 'A', 'Unchanged since it was organized.'),
    'projects/changed/MEMORY.md': index('a.md'),
    'projects/changed/a.md': note('a', 'A', 'Changed since it was organized.'),
    'projects/big/MEMORY.md': lines,
    'projects/big/n0.md': note('n0', 'N0', 'One note.'),
    'projects/conflicted/MEMORY.md': index('a.md'),
    'projects/conflicted/a.md': note('a', 'A', 'One side.'),
    'projects/conflicted/a.conflict-beta.md': note('a', 'A', 'Other side.'),
    'projects/empty/MEMORY.md': '',
  });
  const old = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const recent = new Date(Date.now() - DAY_MS).toISOString();
  mkdirSync(f.state, { recursive: true });
  writeFileSync(f.stateFile(), JSON.stringify({
    projects: {
      same: { lastOrganize: old, organizedDigest: folderDigest(join(f.repo, 'projects/same')) },
      changed: { lastOrganize: old, organizedDigest: 'f'.repeat(64) },
      big: { lastOrganize: recent, organizedDigest: 'e'.repeat(64) },
      conflicted: { lastOrganize: old, organizedDigest: folderDigest(join(f.repo, 'projects/conflicted')) },
    },
  }));
  let r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls().map((c) => c.scope), ['big']);
  assert.match(r.stdout, /^organize big: no-change, 0 change\(s\)/m);

  // big is unchanged since and was organized moments ago: not due, though still over the limit.
  f.setConfig({ maxProjects: 5 });
  r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls().map((c) => c.scope), ['big', 'conflicted', 'changed']);
  assert.doesNotMatch(r.stdout, /organize same|organize empty|organize global/);
  // A no-change run records the scope as organized.
  assert.equal(f.readState().projects.changed.organizedDigest, folderDigest(join(f.repo, 'projects/changed')));
});

test('an unchanged scope still over the limit is due again only after 28 days', (t) => {
  const f = fixture(t);
  const lines = Array.from({ length: 201 }, (_, i) => `- [n${i}](n${i}.md) — line ${i}`).join('\n') + '\n';
  f.seed({ 'projects/big/MEMORY.md': lines, 'projects/big/n0.md': note('n0', 'N0', 'One note.') });
  f.run('organize');
  f.run('organize');
  assert.deepEqual(f.calls().map((c) => c.scope), ['big']);
  const state = f.readState();
  state.projects.big.lastOrganize = new Date(Date.now() - 27 * DAY_MS).toISOString();
  writeFileSync(f.stateFile(), JSON.stringify(state));
  f.run('organize');
  assert.equal(f.calls().length, 1);
  state.projects.big.lastOrganize = new Date(Date.now() - 29 * DAY_MS).toISOString();
  writeFileSync(f.stateFile(), JSON.stringify(state));
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls().map((c) => c.scope), ['big', 'big']);
});

test('with maxProjects 1, two due scopes are both organized over two runs', (t) => {
  const f = fixture(t, { consolidate: { maxProjects: 1 } });
  f.seed({ 'projects/one/a.md': note('a', 'A', 'One.'), 'projects/two/a.md': note('a', 'A', 'Two.') });
  f.run('organize');
  f.run('organize');
  f.run('organize');
  assert.deepEqual(f.calls().map((c) => c.scope).sort(), ['one', 'two']);
});

test('extract takes the project extracted longest ago first; maxProjects bounds the run', (t) => {
  const f = extractFixture(t);
  f.setConfig({ maxProjects: 1 });
  f.seed({ 'projects/q/MEMORY.md': index('y.md'), 'projects/q/y.md': note('y', 'Y', 'Another project.') });
  // q's session is older than p's: newest-session-first would take p.
  f.addSession('-work-q', 'q', 'a question in q', 3 * 3600 * 1000);
  mkdirSync(f.state, { recursive: true });
  const base = Date.now(); // one time for the whole test: two equal marks must be equal
  const days = (n) => new Date(base - n * DAY_MS).toISOString();
  writeFileSync(f.stateFile(), JSON.stringify({ projects: { p: { lastExtract: days(2) }, q: { lastExtract: days(5) } } }));
  f.run('extract');
  assert.deepEqual(f.calls().map((c) => c.scope), ['q']);
  f.run('extract');
  assert.deepEqual(f.calls().map((c) => c.scope), ['q', 'p']);
});

// A project `p` with one interactive session and a project `h` with only a headless one.
function extractFixture(t) {
  const f = fixture(t);
  f.seed({
    'projects/p/MEMORY.md': index('a.md'),
    'projects/p/a.md': note('a', 'Old note', 'An old fact.'),
    'projects/h/MEMORY.md': index('x.md'),
    'projects/h/x.md': note('x', 'X', 'Headless project.'),
  });
  const session = (slug, project, records, ageMs = 3600 * 1000) => {
    const dir = join(f.claudeDir, 'projects', slug);
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(f.repo, 'projects', project), join(dir, 'memory'));
    const file = join(dir, `${slug}-session.jsonl`);
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const then = new Date(Date.now() - ageMs);
    utimesSync(file, then, then);
  };
  // Turns are an hour old, like their files, so that they lie inside the session window.
  const turn = (type, text, extra = {}) => ({
    type, timestamp: new Date(Date.now() - 3600 * 1000).toISOString(),
    message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] }, ...extra,
  });
  session('-work-p', 'p', [turn('user', SESSION_PHRASE, { promptSource: 'typed' }), turn('assistant', 'Noted.')]);
  session('-work-h', 'h', [turn('user', 'run the batch', { promptSource: 'sdk' }), turn('assistant', 'Done.')]);
  f.addSession = (slug, project, text, ageMs) =>
    session(slug, project, [turn('user', text, { promptSource: 'typed' }), turn('assistant', 'Noted.')], ageMs);
  // A session file for `project` holding typed turns given as [text, age in ms].
  f.typedSession = (slug, project, turns, fileAgeMs = 3600 * 1000) => session(slug, project, turns.map(([text, ageMs]) => ({
    type: 'user', promptSource: 'typed', timestamp: new Date(Date.now() - ageMs).toISOString(),
    message: { role: 'user', content: text },
  })), fileAgeMs);
  return f;
}

// ---- Codex sessions (TC-EXTRACT-CODEX-*) ----

// A source repository with an `origin`, and a Codex session file under the test HOME's ~/.codex
// whose directory is `cwd`. Each turn is [role, text, minutes ago].
function codexRepo(f, dir, origin) {
  mkdirSync(dir, { recursive: true });
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['remote', 'add', 'origin', origin]);
  return dir;
}
let codexCount = 0;
function codexSession(f, cwd, turns, { source = 'vscode', extra = [] } = {}) {
  const folder = join(f.home, '.codex', 'sessions', '2026', '11', '18');
  mkdirSync(folder, { recursive: true });
  const id = `c0de${String(codexCount++).padStart(4, '0')}`;
  const file = join(folder, `rollout-2026-11-18T10-00-00-0000-${id}.jsonl`);
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const records = [
    { timestamp: ago(120), type: 'session_meta', payload: { id, timestamp: ago(120), cwd, originator: 'codex-tui', source } },
    ...turns.map(([role, text, min]) => ({
      timestamp: ago(min), type: 'event_msg',
      payload: { type: 'item_completed', item: { type: role === 'user' ? 'UserMessage' : 'AgentMessage', id: `${role}${min}`, content: [{ type: 'text', text }] } },
    })),
    ...extra,
  ];
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { file, id };
}

test('TC-EXTRACT-CODEX-001: a project used only from Codex is extracted, and only its own sessions are read', (t) => {
  const f = fixture(t);
  f.seed({
    'projects/cx/MEMORY.md': index('a.md'),
    'projects/cx/a.md': note('a', 'Old note', 'An old fact.'),
    'projects/cx/.project': 'example.com/owner/cx\n',
  });
  const repo = codexRepo(f, join(f.tmp, 'src', 'cx'), 'https://example.com/owner/cx.git');
  const other = codexRepo(f, join(f.tmp, 'elsewhere', 'cx'), 'https://example.com/someone/cx.git');
  const mine = codexSession(f, repo, [['user', 'CODEX-SESSION-PHRASE which port does staging use?', 60], ['agent', 'Port 8443.', 59]]);
  codexSession(f, other, [['user', 'OTHER-REPOSITORY-PHRASE', 50]]);
  codexSession(f, repo, [['user', 'EXEC-RUN-PHRASE', 40]], { source: 'exec' });

  // Without --project the run takes the project: Codex sessions count for the selection.
  let r = f.run('extract', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls().map((c) => c.scope), ['cx']);

  // The end-to-end check of the issue: --project, a dry run that keeps its work folder.
  r = f.run('extract', '--project', 'cx', '--dry-run', '--keep');
  assert.equal(r.status, 0, r.stderr);
  const call = f.calls().at(-1);
  const digestFile = join(dirname(call.cwd), 'input', 'digest.md');
  assert.ok(r.stdout.includes(dirname(call.cwd)));
  const digest = readFileSync(digestFile, 'utf8');
  assert.equal(digest, call.digest);
  assert.match(digest, new RegExp(`^=== Codex session ${mine.id}, `));
  assert.match(digest, /^USER \(.+\):\nCODEX-SESSION-PHRASE which port does staging use\?$/m);
  assert.match(digest, /^AGENT \(.+\):\nPort 8443\.$/m);
  assert.doesNotMatch(digest, /OTHER-REPOSITORY-PHRASE|EXEC-RUN-PHRASE/);
  assert.equal(f.readState().projects.cx.lastExtract, undefined, 'a dry run moves no mark');
});

test('TC-EXTRACT-CODEX-003: Claude Code and Codex sessions of one project share one digest, newest first', (t) => {
  const f = extractFixture(t);
  f.seed({ 'projects/p/.project': 'example.com/owner/p\n' });
  const repo = codexRepo(f, join(f.tmp, 'src', 'p'), 'git@example.com:owner/p.git');
  const { id } = codexSession(f, repo, [['user', 'CODEX-NEWER-PHRASE', 30]]);
  const r = f.run('extract', '--project', 'p', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  const [call] = f.calls();
  const headers = [...call.digest.matchAll(/^=== (Claude Code|Codex) session (\S+),/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(headers, [`Codex ${id}`, 'Claude Code -work-p-']);
  assert.match(call.digest, new RegExp(SESSION_PHRASE));
  assert.match(call.digest, /CODEX-NEWER-PHRASE/);
});

test('an automated Codex run that wrote a note file into the clone is read', (t) => {
  const f = fixture(t);
  f.seed({ 'projects/cx/MEMORY.md': index('a.md'), 'projects/cx/a.md': note('a', 'A', 'A fact.'), 'projects/cx/.project': 'example.com/owner/cx\n' });
  const repo = codexRepo(f, join(f.tmp, 'src', 'cx'), 'https://example.com/owner/cx.git');
  const change = {
    timestamp: new Date(Date.now() - 20 * 60000).toISOString(), type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'FileChange', id: 'f', status: 'completed', changes: { [join(f.repo, 'projects', 'cx', 'port.md')]: { type: 'add', content: 'x' } } } },
  };
  codexSession(f, repo, [['user', 'AUTOMATED-PROMPT-PHRASE', 30], ['agent', 'AUTOMATED-AGENT-PHRASE: saved the port note.', 25]], { source: 'exec', extra: [change] });
  const r = f.run('extract', '--project', 'cx', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(f.calls()[0].digest, /AUTOMATED-AGENT-PHRASE/);
  assert.doesNotMatch(f.calls()[0].digest, /AUTOMATED-PROMPT-PHRASE/, 'a program\'s prompt is not what the person typed');
});

test('a Codex session whose turns all lie before the last Extract is not read again', (t) => {
  const f = fixture(t);
  f.seed({ 'projects/cx/MEMORY.md': index('a.md'), 'projects/cx/a.md': note('a', 'A', 'A fact.'), 'projects/cx/.project': 'example.com/owner/cx\n' });
  const repo = codexRepo(f, join(f.tmp, 'src', 'cx'), 'https://example.com/owner/cx.git');
  codexSession(f, repo, [['user', 'OLD-CODEX-TURN', 180], ['agent', 'Old answer.', 179]]);
  mkdirSync(f.state, { recursive: true });
  writeFileSync(f.stateFile(), JSON.stringify({ projects: { cx: { lastExtract: new Date(Date.now() - 60 * 60000).toISOString() } } }));
  const r = f.run('extract', '--project', 'cx');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^extract cx: no-session/m);
  assert.deepEqual(f.calls(), []);
});

test('a codexDir that is not an absolute path is reported; Extract goes on without Codex sessions', (t) => {
  const f = extractFixture(t);
  const c = JSON.parse(readFileSync(f.configFile, 'utf8'));
  writeFileSync(f.configFile, JSON.stringify({ ...c, codexDir: '~/.codex' }));
  const r = f.run('extract', '--project', 'p', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^agent-memory consolidate: codexDir in .+ is not an absolute path; Codex sessions are not read\.$/m);
  assert.match(f.calls()[0].digest, new RegExp(SESSION_PHRASE));
});

test('an organize run does not look for Codex sessions', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.seed({ 'projects/p/.project': 'example.com/owner/p\n' });
  const repo = codexRepo(f, join(f.tmp, 'src', 'p'), 'https://example.com/owner/p.git');
  codexSession(f, repo, [['user', 'hello', 30]]);
  const step = (...args) => spawnSync(RUN_SH, ['consolidate-step', 'scan', ...args], { env: f.env, encoding: 'utf8' });
  const scan = step();
  assert.equal(scan.status, 0, scan.stderr);
  assert.deepEqual(JSON.parse(scan.stdout).codexSessions, []);
  const withCodex = step('--codex-since', String(Date.now() - DAY_MS));
  assert.equal(withCodex.status, 0, withCodex.stderr);
  assert.deepEqual(JSON.parse(withCodex.stdout).codexSessions.map(([name, files]) => [name, files.length]), [['p', 1]]);
  // The driver gives the bound: a file written before it is not listed.
  assert.deepEqual(JSON.parse(step('--codex-since', String(Date.now() + DAY_MS)).stdout).codexSessions, []);
  for (const bad of [['--other'], ['--codex-since'], ['--codex-since', 'soon'], ['--codex-since', '-1']]) {
    assert.equal(step(...bad).status, 1, bad.join(' '));
  }
});

test('F3: a session file touched again that holds only turns from before the window is no-session', (t) => {
  const f = extractFixture(t);
  const hours = (n) => n * 3600 * 1000;
  f.typedSession('-work-q', 'h', [['an old question', hours(30)], ['an old answer', hours(29)]], hours(1));
  mkdirSync(f.state, { recursive: true });
  writeFileSync(f.stateFile(), JSON.stringify({ projects: { h: { lastExtract: new Date(Date.now() - hours(2)).toISOString() } } }));
  const r = f.run('extract', '--project', 'h');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^extract h: no-session/m);
  assert.deepEqual(f.calls(), []);
});

test('F3: with lastExtract 60 days ago, only the last 28 days are read', (t) => {
  const f = extractFixture(t);
  f.typedSession('-work-q', 'h', [['FORTY-DAYS-AGO question', 40 * DAY_MS], ['TEN-DAYS-AGO question', 10 * DAY_MS]]);
  mkdirSync(f.state, { recursive: true });
  writeFileSync(f.stateFile(), JSON.stringify({ projects: { h: { lastExtract: new Date(Date.now() - 60 * DAY_MS).toISOString() } } }));
  const r = f.run('extract', '--project', 'h');
  assert.equal(r.status, 0, r.stderr);
  const [call] = f.calls();
  assert.match(call.digest, /TEN-DAYS-AGO/);
  assert.doesNotMatch(call.digest, /FORTY-DAYS-AGO/);
});

test('F3: a cut digest is shown in the headline, the report and lastOutcome; a whole one too', (t) => {
  const f = extractFixture(t);
  const turns = Array.from({ length: 40 }, (_, i) => [`turn ${i} ${'x'.repeat(600)}`, (50 - i) * 60 * 1000]);
  f.typedSession('-work-q', 'h', turns);
  const writes = { 'port.md': note('port', 'Staging port', 'Staging listens on 8443.'), 'MEMORY.md': index('x.md', 'port.md') };
  f.instruct({ h: { writes }, p: { writes: { ...writes, 'MEMORY.md': index('a.md', 'port.md') } } });
  f.setConfig({ maxTranscriptBytes: 10000 });
  let r = f.run('extract', '--project', 'h');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^extract h: applied, 2 change\(s\), USD 0\.25, stopped: completed, conversation text cut$/m);
  let text = readFileSync(join(f.repo, `_reports/${today()}-alpha-extract-h.md`), 'utf8');
  assert.match(text, /^- Conversation text: cut to \d+ bytes; 0 session\(s\) left out$/m);
  let outcome = f.readState().projects.h.lastOutcome;
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.sessionsLeftOut, 0);

  r = f.run('extract', '--project', 'p');
  assert.match(r.stdout, /^extract p: applied, 2 change\(s\), USD 0\.25, stopped: completed$/m);
  text = readFileSync(join(f.repo, `_reports/${today()}-alpha-extract-p.md`), 'utf8');
  assert.match(text, /^- Conversation text: complete$/m);
  outcome = f.readState().projects.p.lastOutcome;
  assert.equal(outcome.truncated, false);
  assert.equal(outcome.sessionsLeftOut, 0);
});

test('extract feeds the digest to the model, applies an added note and never stores the digest', (t) => {
  const f = extractFixture(t);
  f.instruct({
    p: {
      writes: {
        'port.md': note('port', 'Staging port', 'Staging listens on port 8443 (2026-11-13).'),
        'MEMORY.md': index('a.md', 'port.md'),
        'a.md': 'MOVED TO [[port]]\n',
      },
    },
  });
  const r = f.run('extract');
  assert.equal(r.status, 0, r.stderr);
  const calls = f.calls();
  assert.deepEqual(calls.map((c) => c.scope), ['p']);
  const [call] = calls;
  const input = call.args[call.args.indexOf('--add-dir') + 1];
  assert.equal(input, join(dirname(call.cwd), 'input'));
  assert.match(call.args[call.args.indexOf('-p') + 1], new RegExp(`${join(input, 'digest.md')}`));
  assert.match(call.digest, new RegExp(SESSION_PHRASE));
  assert.doesNotMatch(call.digest, /run the batch/);

  assert.match(r.stdout, /^extract p: applied, 2 change\(s\), USD 0\.25/m);
  assert.match(f.subjects()[0], /^consolidate\(alpha\): extract projects\/p \(3 file\(s\)\)$/);
  assert.ok(f.remoteFiles().includes('projects/p/port.md'));
  assert.equal(readFileSync(join(f.repo, 'projects/p/a.md'), 'utf8'), note('a', 'Old note', 'An old fact.'));
  const text = readFileSync(join(f.repo, `_reports/${today()}-alpha-extract-p.md`), 'utf8');
  assert.match(text, /^# Extract p — /m);
  assert.match(text, /^## Added\n- port\.md — Staging port$/m);
  assert.match(text, /^## Not applied\n- a\.md: .+$/m);

  const phrase = new RegExp(SESSION_PHRASE);
  assert.doesNotMatch(treeText(f.repo), phrase);
  assert.doesNotMatch(sh(f.repo, 'git', ['log', '-p', '--all']), phrase);
  assert.doesNotMatch(readFileSync(f.stateFile(), 'utf8'), phrase);
  assert.doesNotMatch(r.stdout + r.stderr, phrase);
  assert.doesNotMatch(r.stdout + text, new RegExp(SUMMARY));
  assert.deepEqual(readdirSync(f.workRoot()), []);

  const state = f.readState().projects;
  assert.ok(!Number.isNaN(Date.parse(state.p.lastExtract)));
  assert.ok(!Number.isNaN(Date.parse(state.h.lastExtract)));
  // Nothing new since lastExtract: a second run calls no model.
  const again = f.run('extract');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(f.calls().length, 1);
});

test('extract with --keep leaves a private work folder and says so', (t) => {
  const f = extractFixture(t);
  const r = f.run('extract', '--project', 'p', '--keep', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  const [call] = f.calls();
  const scopeDir = dirname(call.cwd);
  assert.ok(r.stdout.includes(scopeDir));
  assert.match(r.stdout, /conversation text/);
  assert.equal(statSync(scopeDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(scopeDir, 'input')).mode & 0o777, 0o700);
  assert.equal(statSync(join(scopeDir, 'input/digest.md')).mode & 0o777, 0o600);
  assert.ok(existsSync(join(scopeDir, 'plan.json')));
  assert.ok(existsSync(join(dirname(scopeDir), '.keep')));
  assert.equal(f.readState().projects.p.lastExtract, undefined);
});

test('--dry-run calls the model, commits nothing and prints the report', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.instruct(mergeInstruction());
  const head = f.head();
  const r = f.run('organize', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.calls().length, 1);
  assert.match(r.stdout, /^organize p: dry-run, 3 change\(s\)/m);
  assert.match(r.stdout, /^# Organize p — /m);
  assert.match(r.stdout, /^- b\.md → a\.md$/m);
  assert.equal(f.head(), head);
  assert.ok(existsSync(join(f.repo, 'projects/p/b.md')));
  assert.deepEqual(f.reports(), []);
  const entry = f.readState().projects.p;
  assert.equal(entry.lastOrganize, undefined);
  assert.equal(entry.lastOutcome.outcome, 'dry-run');
});

test('F4: an invalid consolidate block prints one line naming the field and exits 1', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.setConfig({ maxTurns: 2000 });
  for (const args of [['organize'], ['extract', '--dry-run']]) {
    const r = f.run(...args);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, `agent-memory: the consolidate block in ${f.configFile} is invalid (maxTurns); nothing was run.\n`);
  }
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(f.state), false);
});

test('without a consolidate block, or without a config, one line and exit 0', (t) => {
  const f = fixture(t, { block: false });
  duplicateProject(f);
  for (const args of [['organize'], ['extract', '--dry-run']]) {
    const r = f.run(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'agent-memory: consolidation is not configured.\n');
  }
  writeFileSync(f.configFile, 'not json');
  assert.equal(f.run('organize').stdout, 'agent-memory: consolidation is not configured.\n');
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(f.state), false);
});

test('a run stopped by its budget after a valid partial change is applied and reports the stop reason', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  const instruction = mergeInstruction();
  instruction.p.result = { subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 5.01, num_turns: 9 };
  f.instruct(instruction);
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: applied, 3 change\(s\), USD 5\.01, stopped: error_max_budget_usd$/m);
  const text = readFileSync(join(f.repo, `_reports/${today()}-alpha-organize-p.md`), 'utf8');
  assert.match(text, /^- Model: test-model; turns: 9; cost: USD 5\.01; stopped: error_max_budget_usd; denials: 0$/m);
});

test('a model run that changed nothing is no-change, with no commit', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  const head = f.head();
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: no-change, 0 change\(s\), USD 0\.25, stopped: completed$/m);
  assert.equal(f.head(), head);
  assert.deepEqual(f.reports(), []);
  const p = f.readState().projects.p;
  assert.equal(p.organizedDigest, folderDigest(join(f.repo, 'projects/p')));
  assert.ok(p.lastOrganize && p.lastOrganizeTried);
});

test('a model that gives no result still has its valid edits judged and applied', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  const instruction = mergeInstruction();
  instruction.p.silent = true;
  f.instruct(instruction);
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: applied, 3 change\(s\), USD unknown, stopped: no-result$/m);
  assert.equal(existsSync(join(f.repo, 'projects/p/b.md')), false);
  // A model that ran but gave no result spent its budget: the scope counts as tried.
  f.instruct({ p: { silent: true } });
  write(f.repo, 'projects/p/c.md', note('c', 'C', 'Another.'));
  write(f.repo, 'projects/p/MEMORY.md', index('a.md', 'c.md'));
  f.sync();
  const again = f.run('organize');
  // The same model leaving nothing is a failed run: no content mark moves, the run exits 1.
  const digest = f.readState().projects.p.organizedDigest;
  assert.match(again.stdout, /^organize p: model-failed, nothing applied, USD unknown, stopped: no-result$/m);
  assert.equal(again.status, 1);
  assert.equal(f.readState().projects.p.organizedDigest, digest);
});

const ERROR_RESULT = { subtype: 'error_during_execution', is_error: true, total_cost_usd: 0.01, num_turns: 1 };

test('a model that gives no result or an error result and changed nothing is model-failed (extract)', (t) => {
  for (const instruction of [{ silent: true }, { result: ERROR_RESULT }]) {
    const f = extractFixture(t);
    f.instruct({ p: instruction });
    const r = f.run('extract', '--project', 'p');
    const reason = instruction.silent ? 'no-result' : 'error_during_execution';
    const cost = instruction.silent ? 'unknown' : '0.01';
    assert.match(r.stdout, new RegExp(`^extract p: model-failed, nothing applied, USD ${cost}, stopped: ${reason}$`, 'm'));
    assert.equal(r.status, 1);
    const p = f.readState().projects.p;
    assert.equal(p.lastExtract, undefined);
    assert.ok(p.lastExtractTried);
    assert.equal(p.lastOutcome.outcome, 'model-failed');
  }
});

test('a model with an error result that changed nothing is model-failed (organize); a timeout too', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.instruct({ p: { result: ERROR_RESULT } });
  let r = f.run('organize');
  assert.match(r.stdout, /^organize p: model-failed, nothing applied, USD 0\.01, stopped: error_during_execution$/m);
  assert.equal(r.status, 1);
  let p = f.readState().projects.p;
  assert.equal(p.organizedDigest, undefined);
  assert.equal(p.lastOrganize, undefined);
  assert.ok(p.lastOrganizeTried);

  f.env.AGENT_MEMORY_MODEL_TIMEOUT_MS = '1000';
  f.instruct({ p: { sleepMs: 30000 } });
  r = f.run('organize');
  assert.match(r.stdout, /^organize p: model-failed, nothing applied, USD unknown, stopped: timeout$/m);
  assert.equal(r.status, 1);
  p = f.readState().projects.p;
  assert.equal(p.organizedDigest, undefined);
});

test('a model that stops on a limit after an invalid change is rejected and the scope stays unorganized', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.instruct({ p: { writes: { 'notes/b.md': 'MOVED TO [[nothere]]\n' }, result: { subtype: 'error_max_turns', is_error: true } } });
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: rejected, nothing applied \(\d+ rule violation\(s\)\), USD 0\.25, stopped: error_max_turns$/m);
  const p = f.readState().projects.p;
  assert.equal(p.organizedDigest, undefined);
  assert.equal(p.lastOrganize, undefined);
  assert.ok(!Number.isNaN(Date.parse(p.lastOrganizeTried)));
});

const overLimitIndex = () => Array.from({ length: 205 }, (_, i) => `- [n${i}](n${i}.md) — line ${i}`).join('\n') + '\n';

test('F2: an over-limit scope whose model fails does not go first again; a changed scope gets its turn', (t) => {
  const f = fixture(t, { consolidate: { maxProjects: 1 } });
  f.seed({
    'projects/p/MEMORY.md': overLimitIndex(),
    'projects/p/n0.md': note('n0', 'N0', 'One note.'),
    'projects/q/a.md': note('a', 'A', 'Changed.'),
  });
  f.instruct({ p: { silent: true } });
  for (let i = 0; i < 3; i++) f.run('organize');
  assert.deepEqual(f.calls().map((c) => c.scope), ['p', 'q', 'p']);
});

test('F2: failing scopes of every class rotate among themselves', (t) => {
  const f = fixture(t, { consolidate: { maxProjects: 2 } });
  const files = {};
  for (const name of ['s1', 's2']) {
    files[`projects/${name}/MEMORY.md`] = overLimitIndex();
    files[`projects/${name}/n0.md`] = note('n0', 'N0', `Over the limit ${name}.`);
  }
  for (const name of ['s3', 's4']) {
    files[`projects/${name}/a.md`] = note('a', 'A', `One side ${name}.`);
    files[`projects/${name}/a.conflict-beta.md`] = note('a', 'A', `Other side ${name}.`);
  }
  for (const name of ['s5', 's6']) files[`projects/${name}/a.md`] = note('a', 'A', `Plain ${name}.`);
  f.seed(files);
  f.instruct({ '*': { silent: true } });
  for (let i = 0; i < 3; i++) assert.equal(f.run('organize').status, 1);
  assert.deepEqual(f.calls().map((c) => c.scope), ['s1', 's2', 's3', 's4', 's5', 's6']);
  f.run('organize');
  assert.deepEqual(f.calls().slice(6).map((c) => c.scope), ['s1', 's2']);
});

test('F2: a scope that was organized successfully goes before one whose last run failed', (t) => {
  const f = fixture(t, { consolidate: { maxProjects: 1 } });
  f.seed({ 'projects/p/a.md': note('a', 'A', 'Changed since.'), 'projects/q/a.md': note('a', 'A', 'Also changed.') });
  const base = Date.now(); // one time for the whole test: two equal marks must be equal
  const days = (n) => new Date(base - n * DAY_MS).toISOString();
  mkdirSync(f.state, { recursive: true });
  writeFileSync(f.stateFile(), JSON.stringify({
    projects: {
      p: { lastOrganize: days(10), lastOrganizeTried: days(10), organizedDigest: 'f'.repeat(64) },
      q: { lastOrganize: days(20), lastOrganizeTried: days(15), organizedDigest: 'e'.repeat(64) },
    },
  }));
  f.run('organize');
  assert.deepEqual(f.calls().map((c) => c.scope), ['p']);
});

test('with maxProjects 1, an organize scope that always fails does not keep the other waiting', (t) => {
  const f = fixture(t, { consolidate: { maxProjects: 1 } });
  f.seed({ 'projects/p/a.md': note('a', 'A', 'One.'), 'projects/q/a.md': note('a', 'A', 'Two.') });
  f.instruct({ p: { silent: true } });
  let r = f.run('organize');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^organize p: model-failed/m);
  r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls().map((c) => c.scope), ['p', 'q']);
});

test('a dry run with a failing model is model-failed, exits 1 and moves no mark', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.instruct({ p: { silent: true } });
  const r = f.run('organize', '--dry-run');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^organize p: model-failed, nothing applied, USD unknown, stopped: no-result$/m);
  const p = f.readState().projects.p;
  assert.deepEqual(Object.keys(p), ['lastOutcome']);
});

test('extract orders by lastExtractTried: a project rejected every run does not starve the others', (t) => {
  const f = extractFixture(t);
  f.setConfig({ maxProjects: 1 });
  f.seed({ 'projects/q/MEMORY.md': index('y.md'), 'projects/q/y.md': note('y', 'Y', 'Another project.') });
  // q's session is older than p's, so p goes first while neither has been tried.
  f.addSession('-work-q', 'q', 'a question in q', 3 * 3600 * 1000);
  f.instruct({ p: { writes: { 'a.md': '' } } });
  let r = f.run('extract');
  assert.match(r.stdout, /^extract p: rejected, nothing applied/m);
  let p = f.readState().projects.p;
  assert.equal(p.lastExtract, undefined);
  assert.ok(!Number.isNaN(Date.parse(p.lastExtractTried)));
  r = f.run('extract');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls().map((c) => c.scope), ['p', 'p', 'q']);
  p = f.readState().projects.p;
  assert.equal(p.lastExtract, undefined);
  assert.ok(f.readState().projects.q.lastExtractTried);
});

test('state without lastExtractTried loads as never tried; unknown keys survive', (t) => {
  const f = extractFixture(t);
  f.setConfig({ maxProjects: 1 });
  f.seed({ 'projects/q/MEMORY.md': index('y.md'), 'projects/q/y.md': note('y', 'Y', 'Another project.') });
  f.addSession('-work-q', 'q', 'a question in q', 3 * 3600 * 1000);
  const base = Date.now(); // one time for the whole test: two equal marks must be equal
  const days = (n) => new Date(base - n * DAY_MS).toISOString();
  mkdirSync(f.state, { recursive: true });
  writeFileSync(f.stateFile(), JSON.stringify({
    // q's window is older, but q was tried recently and p never was (an earlier version wrote no
    // lastExtractTried): p goes first.
    format: 'old', projects: { p: { lastExtract: days(1), note: 'kept' }, q: { lastExtract: days(5), lastExtractTried: days(0.05) } },
  }));
  f.run('extract');
  assert.deepEqual(f.calls().map((c) => c.scope), ['p']);
  const state = f.readState();
  assert.equal(state.format, 'old');
  assert.equal(state.projects.p.note, 'kept');
});

test('with named projects the run stops starting scopes once its cost reaches their number × maxBudgetUsd', (t) => {
  const f = fixture(t, { consolidate: { maxProjects: 1, maxBudgetUsd: 1 } });
  f.seed({
    'projects/p1/a.md': note('a', 'A', 'One.'),
    'projects/p2/a.md': note('a', 'A', 'Two.'),
    'projects/p3/a.md': note('a', 'A', 'Three.'),
  });
  // Each scope overshoots its own limit: the ceiling of 3 is reached after two.
  f.instruct({ '*': { result: { total_cost_usd: 1.5 } } });
  const r = f.run('organize', '--project', 'p1', '--project', 'p2', '--project', 'p3');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls().map((c) => c.scope), ['p1', 'p2']);
  assert.match(r.stdout, /ceiling of USD 3\.00/);
});

test('item 3: named projects each get their budget; without --project the ceiling is maxProjects × maxBudgetUsd', (t) => {
  let f = fixture(t, { consolidate: { maxProjects: 1, maxBudgetUsd: 1 } });
  f.seed({ 'projects/p1/a.md': note('a', 'A', 'One.'), 'projects/p2/a.md': note('a', 'A', 'Two.') });
  f.instruct({ '*': { result: { total_cost_usd: 1 } } });
  let r = f.run('organize', '--project', 'p1', '--project', 'p2');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls().map((c) => c.scope), ['p1', 'p2']);
  assert.doesNotMatch(r.stdout, /ceiling/);

  f = fixture(t, { consolidate: { maxProjects: 2, maxBudgetUsd: 1 } });
  f.seed({ 'projects/p1/a.md': note('a', 'A', 'One.'), 'projects/p2/a.md': note('a', 'A', 'Two.') });
  f.instruct({ '*': { result: { total_cost_usd: 2 } } });
  r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.calls().length, 1);
  assert.match(r.stdout, /ceiling of USD 2\.00/);
});

test('a second consolidation while one holds the lock exits 0 and calls no model', async (t) => {
  const f = fixture(t);
  duplicateProject(f);
  const lockDir = join(f.home, '.local/state/agent-memory');
  mkdirSync(lockDir, { recursive: true });
  const holder = spawn('bash', ['-c', 'exec 8> "$1"; flock 8; echo held; sleep 30', 'holder', join(lockDir, 'consolidate.lock')],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const r = f.run('organize');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'agent-memory: a consolidation is already running.\n');
  assert.deepEqual(f.calls(), []);
});

test('reports older than 90 days are removed by an applied organize; newer ones stay', (t) => {
  const f = fixture(t);
  const recent = new Date(Date.now() - 10 * DAY_MS).toISOString().slice(0, 10);
  duplicateProject(f);
  f.seed({
    '_reports/2020-01-01-alpha-organize-x.md': '# old\n',
    [`_reports/${recent}-alpha-extract-x.md`]: '# recent\n',
    '_reports/README.md': 'kept\n',
  });
  f.instruct(mergeInstruction());
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.reports(), [`${recent}-alpha-extract-x.md`, `${today()}-alpha-organize-p.md`, 'README.md'].sort());
  assert.ok(!f.remoteFiles().includes('_reports/2020-01-01-alpha-organize-x.md'));
});

test('--min-retention lowers the bar for one run; values outside 0..1 are a usage error', (t) => {
  const f = fixture(t);
  const words = Array.from({ length: 300 }, (_, i) => `term${i}word`).join(' ');
  f.seed({ 'projects/p/MEMORY.md': index('a.md'), 'projects/p/a.md': note('a', 'Many terms', words) });
  f.instruct({ p: { writes: { 'notes/a.md': note('a', 'Few terms', 'Almost nothing is left.') } } });
  let r = f.run('organize');
  assert.match(r.stdout, /^organize p: rejected, nothing applied/m);
  assert.match(r.stdout, /distinct terms/);
  r = f.run('organize', '--project', 'p', '--min-retention', '0');
  assert.match(r.stdout, /^organize p: applied, 1 change\(s\)/m);
  for (const bad of ['1.5', '-0.1', 'x', '']) {
    const u = f.run('organize', '--min-retention', bad);
    assert.equal(u.status, 2);
    assert.match(u.stderr, /usage/);
  }
});

test('usage errors: unknown kind or option, a project that is not a plain project folder', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  symlinkSync(join(f.repo, 'projects/p'), join(f.repo, 'projects/link'));
  const cases = [
    [], ['tidy'], ['organize', '--bogus'], ['organize', '--project'], ['organize', '--project', '../p'],
    ['organize', '--project', 'none'], ['organize', '--project', 'link'], ['organize', '--project', '.git'],
    ['extract', '--project', 'global'], ['organize', '--model', '-x'], ['organize', '--model', 'a b'],
  ];
  for (const args of cases) {
    const r = f.run(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage/);
  }
  assert.deepEqual(f.calls(), []);
});

test('--model replaces the configured model for one run', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.instruct(mergeInstruction());
  const r = f.run('organize', '--model', 'other-model');
  assert.equal(r.status, 0, r.stderr);
  const [call] = f.calls();
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'other-model');
  assert.match(readFileSync(join(f.repo, `_reports/${today()}-alpha-organize-p.md`), 'utf8'), /^- Model: other-model;/m);
});

test('a plan.json changed by the model is refused and nothing is applied', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  const instruction = mergeInstruction();
  instruction.p.writes['plan.json'] = '{"kind":"organize"}';
  f.instruct(instruction);
  const head = f.head();
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: rejected/m);
  assert.match(r.stdout, /plan\.json/);
  assert.equal(f.head(), head);
  assert.ok(existsSync(join(f.repo, 'projects/p/b.md')));
});

test('a failed sync before the snapshot skips the scope and stops the run', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.seed({ 'projects/q/a.md': note('a', 'A', 'Also due.') });
  sh(f.repo, 'git', ['remote', 'set-url', 'origin', join(f.tmp, 'no-such-remote.git')]);
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: sync-failed/m);
  assert.match(r.stdout, /the sync before the snapshot failed/);
  assert.doesNotMatch(r.stdout, /organize q:/);
  assert.match(r.stdout, /^organize: stopped; the sync failed/m);
  assert.deepEqual(f.calls(), []);
  assert.equal(f.readState().projects.p.lastOutcome.outcome, 'sync-failed');
});

const REAL_GIT = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

// Puts a `git` before the real one on the driver's PATH. `script` runs first and may exit.
function wrapGit(f, script) {
  const bin = join(f.tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), `#!/bin/bash\n${script}\nexec ${REAL_GIT} "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  f.env.PATH = `${bin}:${f.env.PATH}`;
}

test('a failed sync after an applied change still counts as applied; the push is pending', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  wrapGit(f, 'for a in "$@"; do if [[ "$a" == push ]]; then echo "fatal: push refused" >&2; exit 1; fi; done');
  f.instruct(mergeInstruction());
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: applied/m);
  assert.match(r.stdout, /push pending/);
  assert.match(f.subjects()[0], /^consolidate\(alpha\): organize projects\/p/);
  assert.ok(f.remoteFiles().includes('projects/p/b.md'));
});

test('a session note in another project during the run gets its own commit; reverting the run keeps it', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.seed({ 'projects/q/MEMORY.md': index('z.md'), 'projects/q/z.md': note('z', 'Z', 'zzz') });
  const session = join(f.repo, 'projects/q/session.md');
  const instruction = mergeInstruction();
  instruction.p.liveWrites = { [session]: note('session', 'S', 'written by a session') };
  f.instruct(instruction);
  const r = f.run('organize', '--project', 'p');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: applied/m);
  const files = (rev) => sh(f.repo, 'git', ['show', '--name-only', '--format=', rev]).trim().split('\n').sort();
  const [consolidate, sync] = f.subjects();
  assert.match(consolidate, /^consolidate\(alpha\): organize projects\/p \(4 file\(s\)\)$/);
  assert.deepEqual(files('HEAD'),
    [`_reports/${today()}-alpha-organize-p.md`, 'projects/p/MEMORY.md', 'projects/p/a.md', 'projects/p/b.md']);
  assert.equal(sync, 'sync(alpha): 1 file(s)');
  assert.deepEqual(files('HEAD~1'), ['projects/q/session.md']);
  sh(f.repo, 'git', ['revert', '--no-edit', 'HEAD']);
  assert.ok(existsSync(join(f.repo, 'projects/p/b.md')));
  assert.match(readFileSync(session, 'utf8'), /written by a session/);
});

test('when the sync before applying fails, nothing is applied and nothing unrelated is committed', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.seed({ 'projects/q/MEMORY.md': index('z.md'), 'projects/q/z.md': note('z', 'Z', 'zzz') });
  const counter = join(f.tmp, 'addcount');
  // The first `git add` is the snapshot's sync; the second, the sync before applying, fails.
  wrapGit(f, `for a in "$@"; do if [[ "$a" == add ]]; then n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"; if [[ $n == 2 ]]; then echo "fatal: Unable to create index.lock: File exists" >&2; exit 128; fi; fi; done`);
  const instruction = mergeInstruction();
  instruction.p.liveWrites = { [join(f.repo, 'projects/q/session.md')]: note('session', 'S', 'written by a session') };
  f.instruct(instruction);
  const head = f.head();
  const r = f.run('organize', '--project', 'p');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: sync-failed/m);
  assert.match(r.stdout, /the sync before applying failed/);
  assert.equal(f.head(), head);
  assert.ok(existsSync(join(f.repo, 'projects/p/b.md')));
  assert.doesNotMatch(readFileSync(join(f.repo, 'projects/p/a.md'), 'utf8'), /Merged from b/);
  assert.deepEqual(f.reports(), []);
  assert.equal(f.readState().projects.p.lastOrganize, undefined);
});

const asRoot = process.getuid?.() === 0;

test('apply refusing part-way ends as changed meanwhile and commits nothing', { skip: asRoot && 'runs as root' }, (t) => {
  const f = fixture(t);
  duplicateProject(f);
  const live = join(f.repo, 'projects/p');
  const instruction = mergeInstruction();
  instruction.p.chmod = { [live]: 0o555 };
  f.instruct(instruction);
  const head = f.head();
  let r;
  try {
    r = f.run('organize');
  } finally {
    chmodSync(live, 0o755);
  }
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: changed meanwhile, nothing applied/m);
  assert.match(r.stdout, /EACCES/);
  assert.equal(f.head(), head);
  assert.ok(existsSync(join(f.repo, 'projects/p/b.md')));
  assert.deepEqual(f.reports(), []);
});

test('a model that timed out still has its valid edits judged and applied', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.env.AGENT_MEMORY_MODEL_TIMEOUT_MS = '1500';
  const instruction = mergeInstruction();
  instruction.p.sleepMs = 30000;
  f.instruct(instruction);
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: applied, 3 change\(s\), USD unknown, stopped: timeout$/m);
  assert.equal(existsSync(join(f.repo, 'projects/p/b.md')), false);
  assert.equal(alive(f.calls()[0].pid), false);
});

test('a model command that cannot start is model-failed and ends the run at once', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.seed({ 'projects/q/a.md': note('a', 'A', 'Also due.') });
  f.setConfig({ command: join(f.tmp, 'no-such-model') });
  const r = f.run('organize');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^organize p: model-failed, nothing applied, USD unknown, stopped: spawn-failed$/m);
  assert.doesNotMatch(r.stdout, /organize q:/);
  const state = f.readState().projects;
  assert.equal(state.p.lastOutcome.outcome, 'model-failed');
  assert.equal(state.p.organizedDigest, undefined);
  assert.equal(state.p.lastOrganizeTried, undefined);
  assert.equal(state.q, undefined);
});

test('a project folder named global is reported and never used', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.seed({ 'projects/global/MEMORY.md': index('x.md'), 'projects/global/x.md': note('x', 'X', 'Never touched.') });
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split('\n').filter((l) => /projects\/global is never consolidated/.test(l)).length, 1);
  assert.deepEqual(f.calls().map((c) => c.scope), ['p']);
});

test('a model-chosen name of a non-note file is ignored and never printed', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  const instruction = mergeInstruction();
  Object.assign(instruction.p.writes, { [`notes/${SESSION_PHRASE}.txt`]: 'x', [`notes/${SESSION_PHRASE}-2.txt`]: 'y' });
  f.instruct(instruction);
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: applied, 3 change\(s\)/m);
  const text = readFileSync(join(f.repo, `_reports/${today()}-alpha-organize-p.md`), 'utf8');
  assert.match(text, /^- \(2 entries that are not note files\): ignored$/m);
  assert.doesNotMatch(r.stdout + r.stderr + text + treeText(f.repo), /UNIQUE-SESSION-PHRASE/);
});

test('a work folder replaced by a link is rejected', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.seed({ 'projects/q/MEMORY.md': index('z.md'), 'projects/q/z.md': note('z', 'Z', 'zzz') });
  f.instruct({ p: { links: { notes: join(f.repo, 'projects/q') } } });
  const head = f.head();
  const r = f.run('organize', '--project', 'p');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: rejected, nothing applied \(1 rule violation\(s\)\)/m);
  assert.match(r.stdout, /^ {2}- notes: work folder is not a real folder$/m);
  assert.equal(f.head(), head);
});

test('an error in a step is reported as such and stops the run with exit 1', { skip: asRoot && 'runs as root' }, (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.seed({ 'projects/q/a.md': note('a', 'A', 'Also due.') });
  f.instruct({ p: { chmod: { notes: 0o000 } } });
  let r;
  try {
    r = f.run('organize');
  } finally {
    // The driver removes the work folder; should it not, the temporary folder must still go.
    spawnSync('chmod', ['-R', 'u+rwx', f.state]);
  }
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^organize p: error, 0 change\(s\), USD 0\.25, stopped: completed$/m);
  assert.match(r.stdout, /^ {2}- the apply step failed: EACCES/m);
  assert.deepEqual(f.calls().map((c) => c.scope), ['p']);
  assert.deepEqual(readdirSync(f.workRoot()), []);
});

test('a state file that cannot be parsed is moved aside; unknown keys of a readable one are kept', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  mkdirSync(f.state, { recursive: true });
  writeFileSync(f.stateFile(), 'not json');
  let r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /the state file could not be read; moved to .*consolidate\.json\.unreadable-\d{8}T\d{6}Z/);
  const aside = readdirSync(f.state).filter((n) => n.startsWith('consolidate.json.unreadable-'));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(join(f.state, aside[0]), 'utf8'), 'not json');
  assert.equal(f.readState().projects.p.lastOutcome.outcome, 'no-change');

  writeFileSync(f.stateFile(), JSON.stringify({ version: 3, projects: { p: { extra: 1 } } }));
  r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  const state = f.readState();
  assert.equal(state.version, 3);
  assert.equal(state.projects.p.extra, 1);
  assert.ok(state.projects.p.organizedDigest);
});

test('a missing clone, or a folder that is not a clone, ends the run with a message and exit 1', (t) => {
  const f = fixture(t);
  const config = JSON.parse(readFileSync(f.configFile, 'utf8'));
  const plain = join(f.tmp, 'plain');
  mkdirSync(plain);
  for (const [repoDir, why] of [[join(f.tmp, 'nowhere'), /does not exist/], [plain, /is not a Git clone/]]) {
    writeFileSync(f.configFile, JSON.stringify({ ...config, repoDir }));
    const r = f.run('organize');
    assert.equal(r.status, 1);
    assert.match(r.stderr, why);
    assert.doesNotMatch(r.stdout, /nothing to do/);
  }
  assert.deepEqual(f.calls(), []);
});

test('run folders older than a day are removed at the start unless marked by --keep', (t) => {
  const f = fixture(t);
  const root = f.workRoot();
  const old = new Date(Date.now() - 2 * DAY_MS);
  for (const name of ['old-run', 'kept-run', 'fresh-run']) {
    write(root, `${name}/p/input/digest.md`, SESSION_PHRASE);
  }
  writeFileSync(join(root, 'kept-run/.keep'), '');
  for (const name of ['old-run', 'kept-run']) utimesSync(join(root, name), old, old);
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(root).sort(), ['fresh-run', 'kept-run']);
});

// True when the process `pid` has a child whose command is `name` (it has started that program).
const hasChild = (pid, name) => spawnSync('pgrep', ['-P', String(pid), '-x', name]).status === 0;

// Makes the n-th `git fetch` of the run wait, so that a test can act while that locked step is
// running. Every fetch is counted in `<tmp>/fetches`; each sync fetches once: the snapshot step's
// sync is the first fetch of a scope, the sync before applying the second, the sync after applying
// the third. The waiting fetch writes the pid of its step to `<tmp>/step.pid` and touches
// `<tmp>/slept` when its wait is over; when its step is gone by then, it exits without fetching.
// Two ways to wait, chosen for what the test does:
// - `hold` (for a signal to the whole process group): a long `sleep` in the foreground. `ready()` is
//   true once that sleep is running, so bash is waiting for a child that the signal ends, and the
//   signal ends bash too. (Signalled while bash still waits for a child that then exits normally,
//   bash would ignore a SIGINT and carry on: that was the race.)
// - otherwise (for a signal to the driver alone, or SIGKILL to the step): a gate. `ready()` is true
//   once the fetch waits at it; it waits until `release()` opens it or its step is gone, so the
//   step is certain to be running when the test signals.
function slowFetch(f, n, { hold = false } = {}) {
  const count = join(f.tmp, 'fetches');
  const marker = join(f.tmp, 'in-step');
  const pidFile = join(f.tmp, 'step.pid');
  const wrapperPid = join(f.tmp, 'wrapper.pid');
  const gate = join(f.tmp, 'gate-open');
  const slept = join(f.tmp, 'slept');
  const wait = hold
    ? 'sleep 30'
    : `while [[ ! -e "${gate}" ]] && kill -0 $PPID 2>/dev/null; do sleep 0.05; done`;
  wrapGit(f, `for a in "$@"; do if [[ "$a" == fetch ]]; then k=$(cat "${count}" 2>/dev/null || echo 0); k=$((k+1)); echo $k > "${count}"; if [[ $k == ${n} ]]; then echo $PPID > "${pidFile}"; echo $$ > "${wrapperPid}"; touch "${marker}"; ${wait}; touch "${slept}"; kill -0 $PPID 2>/dev/null || exit 1; fi; fi; done`);
  const pidIn = (file) => {
    try { return Number(readFileSync(file, 'utf8').trim()) || null; } catch { return null; }
  };
  return {
    marker,
    slept,
    ready: () => existsSync(marker) && (!hold || (pidIn(wrapperPid) !== null && hasChild(pidIn(wrapperPid), 'sleep'))),
    // Also called after the test, when the temporary folder may be gone already.
    release: () => {
      try { writeFileSync(gate, ''); } catch { /* the folder is gone, and with it the step */ }
    },
    stepPid: () => pidIn(pidFile),
    fetches: () => Number(readFileSync(count, 'utf8').trim()),
  };
}

// Starts `run.sh consolidate <args>` and, once `step.ready()` (a locked step is then running),
// sends `signal` to the driver alone, or with `group` to its whole process group as a terminal
// does (the step's Git command dies too); then opens the step's gate. Returns the exit status
// and stdout.
async function signalDuringStep(t, f, signal, step, args, { group = false } = {}) {
  const child = spawn(RUN_SH, ['consolidate', ...args], { env: f.env, stdio: ['ignore', 'pipe', 'ignore'], detached: group });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const exited = new Promise((resolve) => child.once('close', (code, sig) => resolve({ code, signal: sig })));
  t.after(() => {
    step.release();
    try { process.kill(group ? -child.pid : child.pid, 'SIGKILL'); } catch { /* already gone */ }
  });
  assert.ok(await waitFor(step.ready), 'the step is running');
  process.kill(group ? -child.pid : child.pid, signal);
  step.release();
  return { status: await exited, stdout };
}

test('a signal during a locked step ends the run as aborted; the model is never started', async (t) => {
  for (const [signal, code, group] of [['SIGINT', 130, true], ['SIGINT', 130, false], ['SIGTERM', 143, false]]) {
    const f = fixture(t);
    duplicateProject(f);
    f.instruct(mergeInstruction());
    const step = slowFetch(f, 1, { hold: group });
    const head = f.head();
    const { status, stdout } = await signalDuringStep(t, f, signal, step, ['organize'], { group });
    assert.deepEqual(status, { code, signal: null }, signal);
    // No model information on the line: the model was never started.
    assert.match(stdout, /^organize p: aborted, nothing applied, USD 0\.00$/m, signal);
    assert.match(stdout, new RegExp(`^organize: interrupted by ${signal}; nothing more was applied$`, 'm'));
    assert.deepEqual(f.calls(), [], signal);
    assert.equal(f.head(), head, signal);
    assert.deepEqual(readdirSync(f.workRoot()), [], signal);
    assert.equal(f.readState().projects.p.lastOutcome.outcome, 'aborted');
  }
});

test('a terminal signal during the sync after applying: the apply stands and its line says applied', async (t) => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const f = fixture(t);
    duplicateProject(f);
    f.seed({ 'projects/q/a.md': note('a', 'A', 'Also due.') });
    f.instruct(mergeInstruction());
    const step = slowFetch(f, 3, { hold: true });
    const { status, stdout } = await signalDuringStep(t, f, signal, step, ['organize'], { group: true });
    assert.deepEqual(status, { code, signal: null }, signal);
    assert.match(stdout, /^organize p: applied, 3 change\(s\), USD 0\.25, stopped: completed$/m, signal);
    // The signal ended the sync's Git command: the commit is made, the push is pending.
    assert.match(stdout, /push pending/, signal);
    assert.equal(existsSync(step.slept), false, signal);
    assert.ok(f.remoteFiles().includes('projects/p/b.md'), `${signal}: the remote does not have the commit yet`);
    assert.doesNotMatch(stdout, /nothing applied/, signal);
    assert.doesNotMatch(stdout, /organize q:/, signal);
    assert.match(f.subjects()[0], /^consolidate\(alpha\): organize projects\/p/, signal);
    assert.equal(existsSync(join(f.repo, 'projects/p/b.md')), false, signal);
    const p = f.readState().projects.p;
    assert.equal(p.lastOutcome.outcome, 'applied', signal);
    assert.equal(p.organizedDigest, folderDigest(join(f.repo, 'projects/p')), signal);
  }
});

// Makes the fake model take the sync lock for `seconds` just before it ends, so that the apply
// step has to wait for it. Returns `release()`, which ends the holder; call it once the run is
// over. It also runs after the test, but by then the temporary folder (and the pid file in it)
// may be gone, so the pid is read as soon as it can be.
function holdLockAfterModel(t, f, instruction, seconds) {
  const marker = join(f.tmp, 'lock-held');
  instruction.holdLock = { lock: join(f.home, '.local/state/agent-memory/sync.lock'), marker, seconds };
  let pid = null;
  const release = () => {
    try { pid ??= Number(readFileSync(`${marker}.pid`, 'utf8')); } catch { /* not started */ }
    if (pid) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    }
  };
  t.after(release);
  return release;
}

test('an apply step that times out waiting for the lock is step-failed and applies nothing', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  const instruction = mergeInstruction();
  const release = holdLockAfterModel(t, f, instruction.p, 30);
  f.instruct(instruction);
  f.env.AGENT_MEMORY_LOCK_WAIT_SECONDS = '1';
  const head = f.head();
  const r = f.run('organize');
  release();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^organize p: step-failed, 0 change\(s\), USD 0\.25, stopped: completed$/m);
  assert.match(r.stdout, /^ {2}- the apply step could not run: the wait for the sync lock timed out$/m);
  assert.doesNotMatch(r.stdout, /may have been applied|applied/);
  assert.equal(f.head(), head);
  assert.ok(existsSync(join(f.repo, 'projects/p/b.md')));
  const p = f.readState().projects.p;
  assert.equal(p.lastOutcome.outcome, 'step-failed');
  assert.equal(p.organizedDigest, undefined);
  assert.equal(p.lastOrganize, undefined);
});

test('a scan that times out waiting for the lock says so', async (t) => {
  const f = fixture(t);
  duplicateProject(f);
  const lock = join(f.home, '.local/state/agent-memory/sync.lock');
  mkdirSync(dirname(lock), { recursive: true });
  const holder = spawn('flock', [lock, '-c', 'echo held; sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  t.after(() => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* gone */ } });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  f.env.AGENT_MEMORY_LOCK_WAIT_SECONDS = '1';
  const r = f.run('organize');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the scan of the notes could not run: the wait for the sync lock timed out/);
  assert.deepEqual(f.calls(), []);
});

test('a signal while the apply step waits for the lock: aborted, nothing applied', async (t) => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const f = fixture(t);
    duplicateProject(f);
    const instruction = mergeInstruction();
    const release = holdLockAfterModel(t, f, instruction.p, 30);
    f.instruct(instruction);
    const head = f.head();
    const child = spawn(RUN_SH, ['consolidate', 'organize'], { env: f.env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    const exited = new Promise((resolve) => child.once('close', (code2, sig) => resolve({ code: code2, signal: sig })));
    t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } });
    // The apply step is waiting once its run.sh, started with the work folder of this run, is
    // running flock: bash then waits for a child that the signal ends.
    const waiting = () => {
      const found = spawnSync('pgrep', ['-f', `consolidate-step apply --work ${f.state}`], { encoding: 'utf8' });
      return found.status === 0 && found.stdout.trim().split('\n').some((pid) => hasChild(pid, 'flock'));
    };
    assert.ok(await waitFor(waiting), 'the apply step is waiting for the lock');
    process.kill(-child.pid, signal);
    const status = await exited;
    release();
    assert.deepEqual(status, { code, signal: null }, signal);
    assert.match(stdout, /^organize p: aborted, nothing applied, USD 0\.25, stopped: completed$/m, signal);
    assert.doesNotMatch(stdout, /may have been applied/, signal);
    assert.equal(f.head(), head, signal);
    assert.ok(existsSync(join(f.repo, 'projects/p/b.md')), signal);
    assert.equal(f.readState().projects.p.lastOutcome.outcome, 'aborted', signal);
  }
});

test('an apply step killed outright is reported as possibly applied, never as nothing applied', async (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.instruct(mergeInstruction());
  const step = slowFetch(f, 3);
  const child = spawn(RUN_SH, ['consolidate', 'organize'], { env: f.env, stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const exited = new Promise((resolve) => child.once('close', (code, sig) => resolve({ code, signal: sig })));
  t.after(() => {
    step.release();
    child.kill('SIGKILL');
  });
  assert.ok(await waitFor(step.ready), 'the step is running');
  process.kill(step.stepPid(), 'SIGKILL');
  const status = await exited;
  assert.ok(await waitFor(() => existsSync(step.slept)), 'the slow fetch finished');
  assert.deepEqual(status, { code: 1, signal: null });
  assert.match(stdout, /^organize p: apply interrupted, changes may have been applied, USD 0\.25, stopped: completed$/m);
  assert.match(stdout, /log of the notes repository/);
  assert.doesNotMatch(stdout, /nothing applied/);
  assert.equal(f.readState().projects.p.lastOutcome.outcome, 'apply-interrupted');
});

test('an extract applied after a stop other than completed keeps its session window', (t) => {
  const f = extractFixture(t);
  f.instruct({
    p: {
      writes: { 'port.md': note('port', 'Staging port', 'Staging listens on 8443.'), 'MEMORY.md': index('a.md', 'port.md') },
      result: { subtype: 'error_max_budget_usd', is_error: true },
    },
  });
  let r = f.run('extract', '--project', 'p');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^extract p: applied, 2 change\(s\), USD 0\.25, stopped: error_max_budget_usd$/m);
  assert.ok(f.remoteFiles().includes('projects/p/port.md'));
  let p = f.readState().projects.p;
  assert.equal(p.lastExtract, undefined);
  assert.ok(!Number.isNaN(Date.parse(p.lastExtractTried)));

  // The same window is read again; a model that completes moves it on.
  f.instruct({
    p: { writes: { 'more.md': note('more', 'More', 'Another fact.'), 'MEMORY.md': index('a.md', 'port.md', 'more.md') } },
  });
  r = f.run('extract');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^extract p: applied, 2 change\(s\), USD 0\.25, stopped: completed$/m);
  p = f.readState().projects.p;
  assert.ok(!Number.isNaN(Date.parse(p.lastExtract)));
});

test('a signal while the apply step runs: the finished apply stands and the run stops', async (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.seed({ 'projects/q/a.md': note('a', 'A', 'Also due.') });
  f.instruct(mergeInstruction());
  const step = slowFetch(f, 3);
  const { status, stdout } = await signalDuringStep(t, f, 'SIGTERM', step, ['organize']);
  assert.deepEqual(status, { code: 143, signal: null });
  assert.match(stdout, /^organize p: applied, 3 change\(s\), USD 0\.25, stopped: completed$/m);
  assert.match(stdout, /^organize: interrupted by SIGTERM; nothing more was applied$/m);
  assert.doesNotMatch(stdout, /organize q:/);
  assert.match(f.subjects()[0], /^consolidate\(alpha\): organize projects\/p/);
  assert.equal(existsSync(join(f.repo, 'projects/p/b.md')), false);
  assert.deepEqual(f.calls().map((c) => c.scope), ['p']);
  assert.equal(f.readState().projects.p.lastOutcome.outcome, 'applied');
});

test('a signal between two scopes: the next snapshot step never runs', async (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.seed({ 'projects/q/a.md': note('a', 'A', 'Also due.') });
  // p changes nothing, so its apply step makes two fetches; the signal comes during the second.
  const step = slowFetch(f, 2);
  const { status, stdout } = await signalDuringStep(t, f, 'SIGINT', step, ['organize']);
  assert.deepEqual(status, { code: 130, signal: null });
  assert.match(stdout, /^organize p: no-change, 0 change\(s\)/m);
  assert.doesNotMatch(stdout, /organize q:/);
  assert.equal(step.fetches(), 2);
  assert.deepEqual(f.calls().map((c) => c.scope), ['p']);
});

test('m9: run.sh consolidate refuses a first argument starting with --step', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  for (const args of [['--step', 'scan'], ['--step=apply'], ['--steps']]) {
    const r = f.run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage/);
    assert.equal(r.stdout, '');
  }
  assert.equal(existsSync(f.state), false);
});

test('m3: denied tool calls are shown in the headline, the report and lastOutcome', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  const instruction = mergeInstruction();
  instruction.p.result = { permission_denials: [{ tool: 'Write' }, { tool: 'Read' }] };
  f.instruct(instruction);
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: applied, 3 change\(s\), USD 0\.25, stopped: completed, 2 denied tool call\(s\)$/m);
  const text = readFileSync(join(f.repo, `_reports/${today()}-alpha-organize-p.md`), 'utf8');
  assert.match(text, /^- Model: test-model; turns: 4; cost: USD 0\.25; stopped: completed; denials: 2$/m);
  assert.equal(f.readState().projects.p.lastOutcome.denials, 2);
});

test('m1: an apply that fails after its first write is apply-interrupted, not changed meanwhile', { skip: asRoot && 'runs as root' }, (t) => {
  const f = fixture(t);
  duplicateProjectWithGlobal(f);
  const globalDir = join(f.repo, 'global');
  const instruction = mergeInstruction();
  instruction.p.writes['global/g.md'] = note('g', 'General', 'Something general. Edited by this run.');
  instruction.p.chmod = { [globalDir]: 0o555 };
  f.instruct(instruction);
  let r;
  try {
    r = f.run('organize', '--project', 'p');
  } finally {
    chmodSync(globalDir, 0o755);
  }
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^organize p: apply interrupted, changes may have been applied, USD 0\.25, stopped: completed$/m);
  assert.match(r.stdout, /EACCES/);
  assert.doesNotMatch(r.stdout, /nothing applied/);
  const p = f.readState().projects.p;
  assert.equal(p.lastOutcome.outcome, 'apply-interrupted');
  assert.equal(p.organizedDigest, undefined);
});

test('m10: the client\'s standard error of a failed model run is kept in the work folder only', (t) => {
  const marker = 'STDERR-MARKER-2718 the client said this';
  const f = fixture(t);
  duplicateProject(f);
  f.instruct({ p: { silent: true, stderr: marker } });
  let r = f.run('organize', '--keep');
  assert.equal(r.status, 1);
  const [call] = f.calls();
  const log = join(dirname(call.cwd), 'model-stderr-p.log');
  assert.equal(readFileSync(log, 'utf8'), marker);
  assert.equal(statSync(log).mode & 0o777, 0o600);
  const pattern = /STDERR-MARKER-2718/;
  assert.doesNotMatch(r.stdout + r.stderr, pattern);
  assert.doesNotMatch(readFileSync(f.stateFile(), 'utf8'), pattern);
  assert.doesNotMatch(treeText(f.repo), pattern);
  rmSync(f.workRoot(), { recursive: true, force: true });
  r = f.run('organize', '--project', 'p');
  assert.equal(r.status, 1);
  assert.deepEqual(readdirSync(f.workRoot()), []);
  assert.doesNotMatch(r.stdout + r.stderr, pattern);
});

test('item 1: a scope whose last run failed more than 28 days ago goes first again', (t) => {
  for (const [age, expected] of [[29, 'p'], [2, 'q']]) {
    const f = fixture(t, { consolidate: { maxProjects: 1 } });
    f.seed({ 'projects/p/a.md': note('a', 'A', 'Failed once.'), 'projects/q/a.md': note('a', 'A', 'Changes every week.') });
    const base = Date.now(); // one time for the whole test: two equal marks must be equal
    const days = (n) => new Date(base - n * DAY_MS).toISOString();
    mkdirSync(f.state, { recursive: true });
    writeFileSync(f.stateFile(), JSON.stringify({
      projects: {
        p: { lastOrganizeTried: days(age) },
        q: { lastOrganize: days(1), lastOrganizeTried: days(1), organizedDigest: 'f'.repeat(64) },
      },
    }));
    f.run('organize');
    assert.deepEqual(f.calls().map((c) => c.scope), [expected], `${age} days`);
  }
});

test('item 2: a model that writes model-stderr.log itself and fails is model-failed; the driver\'s log is apart', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.seed({ 'projects/q/a.md': note('a', 'A', 'Also due.') });
  f.instruct({
    p: { writes: { 'model-stderr.log': 'WRITTEN BY THE MODEL' }, silent: true, stderr: 'CLIENT-STDERR-MARKER' },
  });
  const r = f.run('organize', '--keep');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^organize p: model-failed, nothing applied/m);
  assert.match(r.stdout, /^organize q: no-change/m);
  const call = f.calls().find((c) => c.scope === 'p');
  const log = join(dirname(call.cwd), 'model-stderr-p.log');
  assert.equal(readFileSync(log, 'utf8'), 'CLIENT-STDERR-MARKER');
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(call.cwd, 'model-stderr.log'), 'utf8'), 'WRITTEN BY THE MODEL');
  assert.equal(existsSync(join(dirname(call.cwd), 'model-stderr-q.log')), false);
});

test('T1: the organize prompt shows the index numbers from the snapshot only when it is over its limit', (t) => {
  const f = fixture(t);
  const big = overLimitIndex();
  f.seed({ 'projects/big/MEMORY.md': big, 'projects/big/n0.md': note('n0', 'N0', 'One note.') });
  duplicateProject(f);
  f.run('organize');
  const prompts = Object.fromEntries(f.calls().map((c) => [c.scope, c.args[c.args.indexOf('-p') + 1]]));
  assert.ok(prompts.big.includes(`MEMORY.md is over its limit now: 205 lines and ${Buffer.byteLength(big)} bytes`));
  assert.ok(!prompts.p.includes('over its limit now'));
});

// T2: one repair run after a result that the rules reject.
const DETAILS = Array.from({ length: 20 }, (_, i) => `detail${String(i).padStart(2, '0')}word`).join(' ');
function repairProject(f) {
  f.seed({
    'projects/p/MEMORY.md': index('a.md', 'b.md'),
    'projects/p/a.md': note('a', 'Deploys', 'Deploys go through staging.'),
    'projects/p/b.md': note('b', 'Details', DETAILS),
  });
}
// The first result retires b.md into a note that does not hold its content: rejected.
const lossyFirst = () => ({
  writes: {
    'notes/a.md': note('a', 'Deploys', 'Deploys go through staging first.'),
    'notes/b.md': 'MOVED TO [[a]]\n',
    'notes/MEMORY.md': index('a.md'),
  },
});
// The repair restores b.md and its index line from original/.
const restoreSecond = () => ({ copies: { 'original/b.md': 'notes/b.md' }, writes: { 'notes/MEMORY.md': index('a.md', 'b.md') } });
const LOSS_LINE = /notes\/b\.md: most of this note's content is missing after the run/;
const consolidateCommits = (f) => f.subjects().filter((x) => x.startsWith('consolidate(')).length;

test('T2: a rejected result is repaired once, with original/, and applied', (t) => {
  const f = fixture(t);
  repairProject(f);
  f.instruct({ p: { ...lossyFirst(), second: restoreSecond() } });
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: applied, 1 change\(s\), USD 0\.50, stopped: completed, one repair run \(1 problem\(s\) found first\)$/m);
  const calls = f.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].originalSeen, false);
  assert.equal(calls[1].originalSeen, true);
  const repairPrompt = calls[1].args[calls[1].args.indexOf('-p') + 1];
  assert.match(repairPrompt, LOSS_LINE);
  assert.ok(repairPrompt.includes(calls[0].args[calls[0].args.indexOf('-p') + 1]), 'the organize task is included');
  assert.equal(calls[1].args[calls[1].args.indexOf('--max-budget-usd') + 1], '4.75');
  assert.equal(consolidateCommits(f), 1);
  assert.match(readFileSync(join(f.repo, 'projects/p/a.md'), 'utf8'), /staging first/);
  assert.equal(readFileSync(join(f.repo, 'projects/p/b.md'), 'utf8'), note('b', 'Details', DETAILS));
  const text = readFileSync(join(f.repo, `_reports/${today()}-alpha-organize-p.md`), 'utf8');
  assert.match(text, /^- Model: test-model; turns: 8; cost: USD 0\.50; stopped: completed; denials: 0$/m);
  assert.match(text, /^- Repair: one repair run; the first check found 1 problem\(s\)$/m);
  const outcome = f.readState().projects.p.lastOutcome;
  assert.equal(outcome.repairs, 1);
  assert.equal(outcome.costUsd, 0.5);
  assert.deepEqual(readdirSync(f.workRoot()), []);
});

test('T2: a repair that is still invalid is rejected with the second check\'s violations; no third run', (t) => {
  const f = fixture(t);
  repairProject(f);
  f.instruct({ p: { ...lossyFirst(), second: { writes: { 'notes/a.md': '' } } } });
  const head = f.head();
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: rejected, nothing applied \(2 rule violation\(s\)\), USD 0\.50, stopped: completed, one repair run \(1 problem\(s\) found first\)$/m);
  assert.match(r.stdout, /^ {2}- notes\/a\.md: a note may not be emptied; retire it instead$/m);
  assert.equal(f.calls().length, 2);
  assert.equal(f.head(), head);
  assert.equal(f.readState().projects.p.lastOutcome.repairs, 1);
});

test('T2: a repair run that does not complete leaves the first check\'s violations', (t) => {
  const f = fixture(t);
  repairProject(f);
  f.instruct({ p: { ...lossyFirst(), second: { silent: true } } });
  const r = f.run('organize');
  assert.match(r.stdout, /^organize p: rejected, nothing applied \(1 rule violation\(s\)\), USD unknown, stopped: no-result, one repair run \(1 problem\(s\) found first\)$/m);
  assert.match(r.stdout, LOSS_LINE);
  assert.equal(f.calls().length, 2);
  assert.ok(existsSync(join(f.repo, 'projects/p/b.md')));
});

test('T2: no repair when the first run did not complete, when too little budget is left, or when a note changed meanwhile', (t) => {
  const cases = {
    'not completed': (f) => f.instruct({ p: { ...lossyFirst(), result: { subtype: 'error_max_turns', is_error: true }, second: restoreSecond() } }),
    'budget left under 0.10': (f) => {
      f.setConfig({ maxBudgetUsd: 0.3 });
      f.instruct({ p: { ...lossyFirst(), second: restoreSecond() } });
    },
    'changed meanwhile': (f) => {
      f.instruct({ p: { ...lossyFirst(), liveWrites: { [join(f.repo, 'projects/p/new.md')]: note('new', 'N', 'A session wrote this.') }, second: restoreSecond() } });
    },
  };
  for (const [name, prepare] of Object.entries(cases)) {
    const f = fixture(t);
    repairProject(f);
    prepare(f);
    const r = f.run('organize');
    assert.equal(f.calls().length, 1, name);
    assert.doesNotMatch(r.stdout, /repair run/, name);
    assert.equal(f.readState().projects.p.lastOutcome.repairs, 0, name);
  }
});

test('T2: a file the repair run writes into original/ never reaches the clone', (t) => {
  const f = fixture(t);
  repairProject(f);
  const second = restoreSecond();
  second.writes['original/x.md'] = note('x', 'X', 'Written into the reference copy.');
  f.instruct({ p: { ...lossyFirst(), second } });
  const r = f.run('organize');
  assert.match(r.stdout, /^organize p: applied/m);
  assert.equal(existsSync(join(f.repo, 'projects/p/x.md')), false);
  assert.ok(!f.remoteFiles().some((x) => x.endsWith('/x.md')));
  assert.deepEqual(readdirSync(f.workRoot()), []);
});

test('T2: a signal during the repair run ends the run as aborted; nothing is applied', async (t) => {
  const f = fixture(t);
  repairProject(f);
  f.instruct({ p: { ...lossyFirst(), second: { ...restoreSecond(), sleepMs: 20000 } } });
  const head = f.head();
  const child = spawn(RUN_SH, ['consolidate', 'organize'], { env: f.env, stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const exited = new Promise((resolve) => child.once('close', (code, sig) => resolve({ code, signal: sig })));
  t.after(() => {
    child.kill('SIGKILL');
    for (const c of f.calls()) {
      try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });
  assert.ok(await waitFor(() => f.calls().length === 2), 'the repair run started');
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 143, signal: null });
  assert.match(stdout, /^organize p: aborted, nothing applied/m);
  assert.equal(f.head(), head);
  assert.ok(existsSync(join(f.repo, 'projects/p/b.md')));
  assert.deepEqual(readdirSync(f.workRoot()), []);
  // m4: the first run started the model, so the scope counts as tried.
  assert.ok(!Number.isNaN(Date.parse(f.readState().projects.p.lastOrganizeTried)));
});

test('T2: a dry run repairs the same way and applies nothing', (t) => {
  const f = fixture(t);
  repairProject(f);
  f.instruct({ p: { ...lossyFirst(), second: restoreSecond() } });
  const head = f.head();
  const r = f.run('organize', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: dry-run, 1 change\(s\), USD 0\.50, stopped: completed, one repair run \(1 problem\(s\) found first\)$/m);
  assert.match(r.stdout, /^- Repair: one repair run; the first check found 1 problem\(s\)$/m);
  assert.equal(f.calls().length, 2);
  assert.equal(f.head(), head);
});

test('T2: Extract gets the same repair run, with original/ as an extra folder', (t) => {
  const f = extractFixture(t);
  f.instruct({
    p: {
      writes: { 'a.md': '' },
      second: {
        copies: { '../original/a.md': 'a.md' },
        writes: { 'port.md': note('port', 'Staging port', 'Staging listens on 8443.'), 'MEMORY.md': index('a.md', 'port.md') },
      },
    },
  });
  const r = f.run('extract', '--project', 'p');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^extract p: applied, 2 change\(s\), USD 0\.50, stopped: completed, one repair run \(1 problem\(s\) found first\)$/m);
  const [, second] = f.calls();
  const dirs = second.args.flatMap((a, i) => (a === '--add-dir' ? [second.args[i + 1]] : []));
  assert.deepEqual(dirs.map((d) => basename(d)).sort(), ['input', 'original']);
  assert.ok(f.remoteFiles().includes('projects/p/port.md'));
  assert.equal(readFileSync(join(f.repo, 'projects/p/a.md'), 'utf8'), note('a', 'Old note', 'An old fact.'));
});

// Fix round 1 of the tuning: a repair that reverts, original/ made by the model.
test('I1: an Extract repair that undoes the first result is rejected and keeps the window', (t) => {
  const f = extractFixture(t);
  f.instruct({ p: { writes: { 'a.md': '' }, second: { copies: { '../original/a.md': 'a.md' } } } });
  const head = f.head();
  const r = f.run('extract', '--project', 'p');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^extract p: rejected, nothing applied \(1 rule violation\(s\)\), USD 0\.50, stopped: completed, one repair run \(1 problem\(s\) found first\)$/m);
  assert.match(r.stdout, /^ {2}- notes\/a\.md: a note may not be emptied; retire it instead$/m);
  assert.equal(f.head(), head);
  const p = f.readState().projects.p;
  assert.equal(p.lastExtract, undefined);
  assert.ok(!Number.isNaN(Date.parse(p.lastExtractTried)));
  assert.equal(p.lastOutcome.outcome, 'rejected');
  assert.equal(p.lastOutcome.repairs, 1);
});

test('I1: an Organize repair that undoes the first result is rejected and records the digest', (t) => {
  const f = fixture(t);
  repairProject(f);
  f.instruct({
    p: {
      ...lossyFirst(),
      second: { copies: { 'original/a.md': 'notes/a.md', 'original/b.md': 'notes/b.md' }, writes: { 'notes/MEMORY.md': index('a.md', 'b.md') } },
    },
  });
  const head = f.head();
  const r = f.run('organize');
  assert.match(r.stdout, /^organize p: rejected, nothing applied \(1 rule violation\(s\)\), USD 0\.50, stopped: completed, one repair run \(1 problem\(s\) found first\)$/m);
  assert.match(r.stdout, LOSS_LINE);
  assert.equal(f.head(), head);
  const p = f.readState().projects.p;
  assert.equal(p.organizedDigest, folderDigest(join(f.repo, 'projects/p')));
  assert.equal(p.lastOutcome.repairs, 1);
});

test('m1: an original/ that the first run made is replaced by the driver\'s copy; the run goes on', (t) => {
  const f = fixture(t);
  repairProject(f);
  f.seed({ 'projects/q/a.md': note('a', 'A', 'Also due.') });
  const first = lossyFirst();
  first.writes['original/planted.md'] = note('planted', 'P', 'Planted by the model.');
  first.writes['original/b.md'] = 'not the real note\n';
  f.instruct({ p: { ...first, second: restoreSecond() } });
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: applied, 1 change\(s\), USD 0\.50, stopped: completed, one repair run/m);
  assert.match(r.stdout, /^organize q: /m);
  const second = f.calls().filter((c) => c.scope === 'p')[1];
  assert.deepEqual(second.originalFiles, ['MEMORY.md', 'a.md', 'b.md']);
  assert.equal(readFileSync(join(f.repo, 'projects/p/b.md'), 'utf8'), note('b', 'Details', DETAILS));
});

test('m1: an original/ that the model made gets no repair run without the driver\'s copy', (t) => {
  for (const extra of [{}, { 'plan.json': '{"kind":"organize"}' }]) {
    const f = fixture(t);
    duplicateProject(f);
    const instruction = mergeInstruction();
    Object.assign(instruction.p.writes, { 'original/x.md': note('x', 'X', 'Made by the model.'), ...extra });
    instruction.p.second = restoreSecond();
    f.instruct(instruction);
    const r = f.run('organize');
    assert.equal(f.calls().length, 1, Object.keys(extra).join() || 'valid result');
    assert.doesNotMatch(r.stdout, /repair run/);
    assert.equal(existsSync(join(f.repo, 'projects/p/x.md')), false);
  }
});

test('S1: a scratch file beside a good result in notes/ and global/ is ignored, counted, never applied', (t) => {
  const f = fixture(t);
  duplicateProjectWithGlobal(f);
  const instruction = mergeInstruction();
  Object.assign(instruction.p.writes, { 'notes/a.md.tmp': 'half-written', 'notes/sub/x.txt': 'x', 'global/scratch.tmp': 'y' });
  f.instruct(instruction);
  const r = f.run('organize', '--project', 'p');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: applied, 3 change\(s\)/m);
  const text = readFileSync(join(f.repo, `_reports/${today()}-alpha-organize-p.md`), 'utf8');
  assert.match(text, /^- \(2 entries that are not note files\): ignored$/m);
  assert.match(text, /^- global\/\(1 entry that is not a note file\): ignored$/m);
  assert.ok(!f.remoteFiles().some((x) => /\.tmp$|sub\//.test(x)));
  assert.equal(existsSync(join(f.repo, 'projects/p/a.md.tmp')), false);
});

// ---- organize --agents: the agent scopes of the memory API's bucket (TC-AGENT-ORG-*) ----

const AGENT_FACTS = 'Deploys always go through the staging stack first; staging listens on port 8443, production answers on port 443 behind the shared load balancer, and every release needs a signed changelog entry before promotion.';
const apiNote = (name, description, content) =>
  ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`, 'metadata:', '  type: reference', '---', '', content].join('\n') + '\n';
const apiLine = (name, description) => `- [${name}](${name}.md) — ${description}`;
const md5 = (text) => `"${createHash('md5').update(text).digest('hex')}"`;
const AGENTS_BLOCK = { bucket: 'example-bucket', region: 'ap-northeast-1', credentials: 'environment' };

// A fake bucket in a file (see fake-s3-preload.mjs) holding the agent scope codex-alpha with two
// notes that say the same thing, and the driver's environment to reach it.
function agentsFixture(t, { block = AGENTS_BLOCK, consolidate = {} } = {}) {
  const f = fixture(t, { consolidate: { agents: block, ...consolidate } });
  const bucketFile = join(f.tmp, 'bucket.json');
  const logFile = join(f.tmp, 's3.log');
  const objects = {};
  const put = (key, text) => { objects[key] = { body: Buffer.from(text).toString('base64'), etag: md5(text) }; };
  put('agents/codex-alpha/deploys.md', apiNote('deploys', 'How deploys go', AGENT_FACTS));
  put('agents/codex-alpha/deploy-steps.md', apiNote('deploy-steps', 'Deploy steps', AGENT_FACTS));
  put('agents/codex-alpha/MEMORY.md', `${apiLine('deploys', 'How deploys go')}\n${apiLine('deploy-steps', 'Deploy steps')}\n`);
  put('index/agents.json', JSON.stringify({ version: 1, notes: [
    { path: 'agents/codex-alpha/deploy-steps.md', name: 'deploy-steps', description: 'Deploy steps', type: 'reference', body: AGENT_FACTS },
    { path: 'agents/codex-alpha/deploys.md', name: 'deploys', description: 'How deploys go', type: 'reference', body: AGENT_FACTS },
  ] }));
  writeFileSync(bucketFile, JSON.stringify(objects));
  f.setConfig({ env: { FAKE_INSTRUCTIONS: join(f.tmp, 'instructions.json'), FAKE_CALLS: join(f.tmp, 'calls.jsonl'), FAKE_SUMMARY: SUMMARY, FAKE_S3_FILE: bucketFile } });
  const awsEnv = {
    NODE_OPTIONS: `--import ${join(PKG, 'test', 'fake-s3-preload.mjs')}`, FAKE_S3_FILE: bucketFile, FAKE_S3_LOG: logFile,
    AWS_ACCESS_KEY_ID: 'ASIAEXAMPLEKEYID0001', AWS_SECRET_ACCESS_KEY: 'example-signing-value', AWS_SESSION_TOKEN: 'example-session-value',
  };
  const bucket = () => Object.fromEntries(Object.entries(JSON.parse(readFileSync(bucketFile, 'utf8'))).map(([k, o]) => [k, Buffer.from(o.body, 'base64').toString('utf8')]));
  const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { ...f, bucketFile, bucket, log, runAgents: (...args) => f.runWith(awsEnv, 'organize', '--agents', ...args), awsEnv };
}

const MERGED_DEPLOYS = apiNote('deploys', 'How deploys go (merged)', `${AGENT_FACTS} Steps: build, deploy to staging, check, promote.`);
const agentMerge = () => ({
  'agents-codex-alpha': {
    writes: {
      'notes/deploys.md': MERGED_DEPLOYS,
      'notes/deploy-steps.md': 'MOVED TO [[deploys]]\n',
      'notes/MEMORY.md': `${apiLine('deploys', 'How deploys go, with the steps')}\n`,
    },
  },
});
const writes = (log) => log.filter((r) => r.method === 'PUT' || r.method === 'DELETE');

test('TC-AGENT-ORG-001 (driver): organize --agents merges two duplicate notes and records the scope in the bucket', (t) => {
  const f = agentsFixture(t);
  f.instruct(agentMerge());
  const r = f.runAgents();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize agents\/codex-alpha: applied, 3 change\(s\), USD 0\.25, stopped: completed$/m);
  assert.match(r.stdout, /^# Organize agents\/codex-alpha — /m);
  assert.match(r.stdout, /^- deploy-steps\.md → deploys\.md$/m);
  const b = f.bucket();
  assert.equal(b['agents/codex-alpha/deploy-steps.md'], undefined);
  assert.equal(b['agents/codex-alpha/deploys.md'], MERGED_DEPLOYS);
  assert.equal(b['agents/codex-alpha/MEMORY.md'], `${apiLine('deploys', 'How deploys go, with the steps')}\n`);
  assert.deepEqual(JSON.parse(b['index/agents.json']).notes.map((n) => n.path), ['agents/codex-alpha/deploys.md']);
  const state = JSON.parse(b['index/organizer.json']).scopes['codex-alpha'];
  assert.ok(state.lastOrganize && state.lastOrganizeTried && /^[0-9a-f]{64}$/.test(state.organizedDigest));
  assert.equal(state.lastOutcome.outcome, 'applied');
  // Every write was conditional.
  for (const w of writes(f.log())) assert.ok(w.ifMatch !== null || w.ifNoneMatch === '*', `${w.method} ${w.key}`);
  // Nothing changed since: the next run takes nothing and calls no model.
  const again = f.runAgents();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^organize: nothing to do$/m);
  assert.equal(f.calls().length, 1);
  // The model worked on a copy; it never saw the run's credentials.
  assert.doesNotMatch(JSON.stringify(f.calls()), /ASIAEXAMPLE|example-signing/);
});

test('TC-AGENT-ORG-004: organize --agents --dry-run reports the result and writes nothing to the bucket', (t) => {
  const f = agentsFixture(t);
  f.instruct(agentMerge());
  const before = readFileSync(f.bucketFile, 'utf8');
  const r = f.runAgents('--dry-run', '--keep');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize agents\/codex-alpha: dry-run, 3 change\(s\)/m);
  assert.match(r.stdout, /^- deploy-steps\.md → deploys\.md$/m);
  assert.deepEqual(writes(f.log()), []);
  assert.equal(readFileSync(f.bucketFile, 'utf8'), before);
  assert.match(r.stdout, /work folder kept: /);
});

test('TC-AGENT-ORG-003 (driver): a note an agent writes while the model runs is kept; nothing of the run is applied', (t) => {
  const f = agentsFixture(t);
  const theirs = apiNote('fresh', 'Written meanwhile', 'An agent wrote this through the API during the run.');
  f.instruct({ 'agents-codex-alpha': { ...agentMerge()['agents-codex-alpha'], bucketWrites: { 'agents/codex-alpha/fresh.md': theirs } } });
  const r = f.runAgents();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize agents\/codex-alpha: changed meanwhile, nothing applied/m);
  assert.match(r.stdout, /^ {2}- changed meanwhile: fresh\.md$/m);
  const b = f.bucket();
  assert.equal(b['agents/codex-alpha/fresh.md'], theirs);
  assert.ok(b['agents/codex-alpha/deploy-steps.md'], 'nothing retired');
  assert.equal(writes(f.log()).filter((w) => w.key !== 'index/organizer.json').length, 0);
  const state = JSON.parse(b['index/organizer.json']).scopes['codex-alpha'];
  assert.equal(state.organizedDigest, undefined, 'the scope stays due');
  assert.ok(state.lastOrganizeTried);
});

test('TC-AGENT-ORG-002 (driver): a result that drops content is rejected after one repair run; the bucket is unchanged', (t) => {
  const f = agentsFixture(t);
  f.instruct({ 'agents-codex-alpha': { writes: {
    'notes/deploys.md': apiNote('deploys', 'How deploys go', 'Deploys exist.'),
    'notes/deploy-steps.md': 'MOVED TO [[deploys]]\n',
    'notes/MEMORY.md': `${apiLine('deploys', 'How deploys go')}\n`,
  } } });
  const before = Object.entries(f.bucket()).filter(([k]) => k !== 'index/organizer.json');
  const r = f.runAgents();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize agents\/codex-alpha: rejected, nothing applied \(\d+ rule violation\(s\)\), USD 0\.50, stopped: completed, one repair run/m);
  assert.match(r.stdout, /most of this note's content is missing/);
  assert.equal(f.calls().length, 2);
  assert.deepEqual(Object.entries(f.bucket()).filter(([k]) => k !== 'index/organizer.json'), before);
  assert.doesNotMatch(r.stdout, /search entries/, 'entries in step are left alone');
  // A completed model that was rejected marks the content as seen: the next run does not repeat it.
  assert.match(f.runAgents().stdout, /^organize: nothing to do$/m);
});

test('organize --agents: a rejected result on a scope with entries out of step still rewrites the entries', (t) => {
  const f = agentsFixture(t);
  const objects = JSON.parse(readFileSync(f.bucketFile, 'utf8'));
  const doc = JSON.parse(Buffer.from(objects['index/agents.json'].body, 'base64').toString('utf8'));
  doc.notes = doc.notes.filter((n) => n.path !== 'agents/codex-alpha/deploy-steps.md');
  const text = JSON.stringify(doc);
  objects['index/agents.json'] = { body: Buffer.from(text).toString('base64'), etag: md5(text) };
  writeFileSync(f.bucketFile, JSON.stringify(objects));
  f.instruct({ 'agents-codex-alpha': { writes: { 'notes/deploys.md': apiNote('deploys', 'How deploys go', 'Deploys exist.') } } });
  const r = f.runAgents();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize agents\/codex-alpha: rejected, nothing applied/m);
  assert.match(r.stdout, /^ {2}- the search entries of the scope did not match its notes and were rewritten from them$/m);
  assert.deepEqual(JSON.parse(f.bucket()['index/agents.json']).notes.map((n) => n.path), ['agents/codex-alpha/deploy-steps.md', 'agents/codex-alpha/deploys.md']);
  assert.equal(f.bucket()['agents/codex-alpha/deploys.md'], apiNote('deploys', 'How deploys go', AGENT_FACTS), 'the notes are untouched');
});

test('organize --agents: a scope with an object too large to be a note is skipped; the next scope still runs', (t) => {
  const f = agentsFixture(t);
  const objects = JSON.parse(readFileSync(f.bucketFile, 'utf8'));
  objects['agents/aaa-first/huge.md'] = { body: Buffer.from('x'.repeat(1_000_001)).toString('base64'), etag: '"huge"' };
  writeFileSync(f.bucketFile, JSON.stringify(objects));
  f.instruct(agentMerge());
  const r = f.runAgents();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize agents\/aaa-first: skipped, 0 change\(s\), USD 0\.00$/m);
  assert.match(r.stdout, /^ {2}- a note of this scope is larger than 1000000 bytes$/m);
  assert.match(r.stdout, /^organize agents\/codex-alpha: applied, 3 change\(s\)/m);
  // It goes to the back of the queue: it never keeps the others waiting.
  assert.ok(JSON.parse(f.bucket()['index/organizer.json']).scopes['aaa-first'].lastOrganizeTried);
});

test('organize --agents: search entries out of step with the notes are reported by a dry run and rewritten by a run', (t) => {
  const f = agentsFixture(t);
  const objects = JSON.parse(readFileSync(f.bucketFile, 'utf8'));
  const doc = JSON.parse(Buffer.from(objects['index/agents.json'].body, 'base64').toString('utf8'));
  doc.notes = doc.notes.filter((n) => n.path !== 'agents/codex-alpha/deploy-steps.md');
  const text = JSON.stringify(doc);
  objects['index/agents.json'] = { body: Buffer.from(text).toString('base64'), etag: md5(text) };
  writeFileSync(f.bucketFile, JSON.stringify(objects));
  f.instruct({});
  const dry = f.runAgents('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^organize agents\/codex-alpha: no-change, 0 change\(s\)/m);
  assert.match(dry.stdout, /^ {2}- the search entries of the scope do not match its notes; a run without --dry-run rewrites them$/m);
  assert.deepEqual(writes(f.log()), []);
  const r = f.runAgents();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}- the search entries of the scope did not match its notes and were rewritten from them$/m);
  assert.deepEqual(JSON.parse(f.bucket()['index/agents.json']).notes.map((n) => n.path), ['agents/codex-alpha/deploy-steps.md', 'agents/codex-alpha/deploys.md']);
});

test('organize --agents: usage errors, a missing agents block and missing credentials', (t) => {
  const f = agentsFixture(t);
  for (const args of [['--project', 'p'], ['--agent', 'Bad_Name'], ['--agent']]) {
    const r = f.runAgents(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^usage: /m);
  }
  assert.equal(f.runWith(f.awsEnv, 'extract', '--agents').status, 2);
  const unknown = f.runAgents('--agent', 'nobody');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /"nobody" is not an agent scope of the bucket\./);
  const noCreds = f.runWith({ ...f.awsEnv, AWS_SESSION_TOKEN: '' }, 'organize', '--agents');
  assert.equal(noCreds.status, 1);
  assert.match(noCreds.stderr, /the agent scopes could not be read \(credentials failed: 0 NoEnvironment\)/);
  const plain = agentsFixture(t, { block: null });
  const r = plain.runAgents();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /organizing the agent scopes needs "agents" in the consolidate block/);
  assert.deepEqual(plain.calls(), []);
});

// ---- The label steps: run.sh consolidate-step label-read | label-apply ----

// A note whose metadata block carries `domain: <label>`, as label-apply writes it.
const labeledNote = (name, description, body, label) =>
  note(name, description, body).replace('  type: project\n', `  type: project\n  domain: ${label}\n`);

const liveText = (f, rel) => readFileSync(join(f.repo, rel), 'utf8');

// Runs a step through run.sh, under the sync lock, as the driver does: its exit status and its JSON line.
function runLabelStep(f, ...args) {
  const r = spawnSync(RUN_SH, ['consolidate-step', ...args], { env: f.env, encoding: 'utf8' });
  const line = r.stdout.trim().split('\n').at(-1);
  return { status: r.status, stderr: r.stderr, result: line ? JSON.parse(line) : null };
}

// A new, empty work folder where the driver makes one: <stateDir>/consolidate/<run>/<folder>.
function labelWork(f) {
  const run = join(f.workRoot(), 'run');
  mkdirSync(run, { recursive: true, mode: 0o700 });
  return mkdtempSync(join(run, 'label-'));
}

// label-read in a new work folder: the folder, the step's line and what it wrote to label-notes.json.
function labelRead(f, ...args) {
  const work = labelWork(f);
  const r = runLabelStep(f, 'label-read', '--work', work, ...args);
  assert.equal(r.status, 0, r.stderr);
  return { work, result: r.result, ...JSON.parse(readFileSync(join(work, 'label-notes.json'), 'utf8')) };
}

// Writes label-plan.json (an object as JSON, a string as it is) and returns its SHA-256.
function writeLabelPlan(work, plan) {
  const text = typeof plan === 'string' ? plan : `${JSON.stringify(plan, null, 2)}\n`;
  writeFileSync(join(work, 'label-plan.json'), text, { mode: 0o600 });
  return sha(text);
}

// The plan entry that gives `label` to the note at `path` as label-read listed it.
const entryFor = (notes, path, label) => ({ path, label, sha256: notes.find((n) => n.path === path).sha256 });

const labelApply = (f, work, planSha) => runLabelStep(f, 'label-apply', '--work', work, '--plan-sha256', planSha);

test('label-read lists the notes of every scope', (t) => {
  const f = fixture(t);
  f.seed({
    'global/MEMORY.md': index('a.md'),
    'global/a.md': labeledNote('a', 'About a', 'Alpha.', 'work'),
    'projects/p/MEMORY.md': index('b.md'),
    'projects/p/b.md': note('b', 'About b', 'Beta.'),
    'projects/p/old.md': 'MOVED TO [[b]]\n',
    'projects/p/x.conflict-host.md': note('b', 'About b', 'Beta, as another machine wrote it.'),
  });
  const { work, result, notes, digests } = labelRead(f);
  assert.equal(result.outcome, 'label-read');
  assert.equal(result.notes, 2);
  assert.equal(result.sync.ok, true);
  const digestOf = (rel) => sha(readFileSync(join(f.repo, rel)));
  assert.deepEqual(notes, [
    {
      path: 'global/a.md', scope: 'global', file: 'a.md', sha256: digestOf('global/a.md'), domain: 'work',
      name: 'a', description: 'About a', body: '\nAlpha.\n', skip: null,
    },
    {
      path: 'projects/p/b.md', scope: 'projects/p', file: 'b.md', sha256: digestOf('projects/p/b.md'), domain: null,
      name: 'b', description: 'About b', body: '\nBeta.\n', skip: null,
    },
  ]);
  assert.deepEqual(digests, { global: folderDigest(join(f.repo, 'global')), p: folderDigest(join(f.repo, 'projects/p')) });
  assert.equal(statSync(join(work, 'label-notes.json')).mode & 0o777, 0o600);
});

test('label-read takes only the named scopes', (t) => {
  const f = fixture(t);
  f.seed({
    'global/g.md': note('g', 'G', 'General.'),
    'projects/p/b.md': note('b', 'B', 'Beta.'),
    'projects/q/c.md': note('c', 'C', 'Gamma.'),
  });
  // A session's note that is not committed yet: the step's sync commits it before the notes are read.
  write(f.repo, 'projects/p/d.md', note('d', 'D', 'Delta.'));
  const { work, result, notes, digests } = labelRead(f, '--scope', 'p', '--scope', 'gone', '--scope', 'p');
  assert.equal(result.notes, 2);
  assert.equal(result.sync.committed, 1);
  assert.deepEqual(notes.map((n) => n.path), ['projects/p/b.md', 'projects/p/d.md']);
  // A named scope without a folder is left out.
  assert.deepEqual(Object.keys(digests), ['p']);
  // A work folder that is not empty, or a scope name no scope folder may have, is an error before anything is read.
  assert.equal(runLabelStep(f, 'label-read', '--work', work).result.outcome, 'error');
  for (const bad of [['--scope', '../p'], ['--scope', '.p'], ['--scope', 'a/b'], ['--scope'], ['--other', 'x']]) {
    const w = labelWork(f);
    const r = runLabelStep(f, 'label-read', '--work', w, ...bad);
    assert.equal(r.status, 1, bad.join(' '));
    assert.equal(r.result.outcome, 'error', bad.join(' '));
    assert.deepEqual(readdirSync(w), [], bad.join(' '));
  }
});

test('label-apply writes the labels and commits them', (t) => {
  const f = fixture(t);
  f.seed({
    'global/MEMORY.md': index('a.md'),
    'global/a.md': note('a', 'A', 'Alpha.'),
    'projects/p/MEMORY.md': index('b.md', 'c.md'),
    'projects/p/b.md': note('b', 'B', 'Beta.'),
    'projects/p/c.md': labeledNote('c', 'C', 'Gamma.', 'general'),
  });
  const { work, notes } = labelRead(f);
  const before = { global: folderDigest(join(f.repo, 'global')), p: folderDigest(join(f.repo, 'projects/p')) };
  const report = '# Labels — test\n\n- global/a.md: personal\n- projects/p/b.md: work\n';
  const planSha = writeLabelPlan(work, {
    entries: [
      entryFor(notes, 'global/a.md', 'personal'), entryFor(notes, 'projects/p/b.md', 'work'),
      entryFor(notes, 'projects/p/c.md', 'general'),
    ],
    report,
  });
  const r = labelApply(f, work, planSha);
  assert.equal(r.status, 0, r.stderr);
  const res = r.result;
  assert.equal(res.outcome, 'applied');
  assert.equal(liveText(f, 'global/a.md'), labeledNote('a', 'A', 'Alpha.', 'personal'));
  assert.equal(liveText(f, 'projects/p/b.md'), labeledNote('b', 'B', 'Beta.', 'work'));
  const digestOf = (rel) => sha(readFileSync(join(f.repo, rel)));
  assert.deepEqual(res.written, [
    { path: 'global/a.md', sha256: digestOf('global/a.md') },
    { path: 'projects/p/b.md', sha256: digestOf('projects/p/b.md') },
  ]);
  assert.deepEqual(res.unchanged, [{ path: 'projects/p/c.md', sha256: digestOf('projects/p/c.md') }]);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(res.digests, {
    global: { before: before.global, after: folderDigest(join(f.repo, 'global')) },
    p: { before: before.p, after: folderDigest(join(f.repo, 'projects/p')) },
  });
  assert.notEqual(res.digests.p.before, res.digests.p.after);
  assert.equal(res.reportError, null);
  assert.deepEqual(res.sync, { ok: true, error: null, committed: 3, pushed: true });
  // The subject given to the sync, which adds the file count as it does for every consolidate commit.
  assert.equal(f.subjects()[0], 'consolidate(alpha): label 2 note(s) (3 file(s))');
  const reportFile = `_reports/${today()}-alpha-label.md`;
  assert.deepEqual(sh(f.repo, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort(),
    [reportFile, 'global/a.md', 'projects/p/b.md']);
  assert.equal(liveText(f, reportFile), report);
  assert.equal(f.head(), sh(f.remote, 'git', ['rev-parse', 'main']).trim());
});

test('label-apply skips a note changed after the read', (t) => {
  const f = fixture(t);
  f.seed({ 'projects/p/b.md': note('b', 'B', 'Beta.'), 'projects/p/d.md': note('d', 'D', 'Delta.') });
  const { work, notes } = labelRead(f);
  // A session edits b.md and removes d.md after the read.
  const edited = note('b', 'B', 'Beta, edited by a session.');
  write(f.repo, 'projects/p/b.md', edited);
  rmSync(join(f.repo, 'projects/p/d.md'));
  const planSha = writeLabelPlan(work, {
    entries: [entryFor(notes, 'projects/p/b.md', 'work'), entryFor(notes, 'projects/p/d.md', 'work')],
    report: '# Labels\n',
  });
  const r = labelApply(f, work, planSha);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.outcome, 'no-change');
  assert.deepEqual(r.result.written, []);
  assert.deepEqual(r.result.skipped, [
    { path: 'projects/p/b.md', reason: 'changed since it was read' },
    { path: 'projects/p/d.md', reason: 'gone' },
  ]);
  assert.equal(liveText(f, 'projects/p/b.md'), edited);
  assert.equal(r.result.digests.p.before, r.result.digests.p.after);
  // Nothing was written: no report and no label commit. The step's first sync committed the session's changes.
  assert.deepEqual(f.reports(), []);
  assert.equal(f.subjects()[0], 'sync(alpha): 2 file(s)');
});

test('label-apply names a note it cannot edit', (t) => {
  const f = fixture(t);
  const inline = '---\nname: c\ndescription: C\nmetadata: {}\n---\n\nGamma.\n';
  f.seed({ 'projects/p/b.md': note('b', 'B', 'Beta.'), 'projects/p/c.md': inline });
  const { work, notes } = labelRead(f);
  // label-read names it already, so that the pass can keep it away from the model.
  assert.equal(notes.find((n) => n.path === 'projects/p/c.md').skip, 'metadata is not a block');
  const planSha = writeLabelPlan(work, {
    entries: [entryFor(notes, 'projects/p/b.md', 'work'), entryFor(notes, 'projects/p/c.md', 'personal')],
    report: '# Labels\n',
  });
  const r = labelApply(f, work, planSha);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.outcome, 'applied');
  assert.deepEqual(r.result.skipped, [{ path: 'projects/p/c.md', reason: 'metadata is not a block' }]);
  assert.equal(liveText(f, 'projects/p/c.md'), inline);
  assert.equal(liveText(f, `_reports/${today()}-alpha-label.md`),
    '# Labels\n\n## Not written\n- projects/p/c.md: metadata is not a block\n');
  assert.equal(f.subjects()[0], 'consolidate(alpha): label 1 note(s) (2 file(s))');
});

test('label-apply commits the labels when the report cannot be written', (t) => {
  const f = fixture(t);
  f.seed({ '_reports': 'a file where the report folder would be\n', 'projects/p/b.md': note('b', 'B', 'Beta.') });
  const { work, notes } = labelRead(f);
  const r = labelApply(f, work, writeLabelPlan(work, { entries: [entryFor(notes, 'projects/p/b.md', 'work')], report: '# Labels\n' }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.outcome, 'applied');
  assert.equal(r.result.reportError, '_reports is not a folder');
  assert.equal(r.result.sync.ok, true);
  assert.equal(f.subjects()[0], 'consolidate(alpha): label 1 note(s) (1 file(s))');
  assert.equal(liveText(f, 'projects/p/b.md'), labeledNote('b', 'B', 'Beta.', 'work'));
});

test('label-apply refuses a plan changed after it was written', (t) => {
  const f = fixture(t);
  f.seed({ 'projects/p/b.md': note('b', 'B', 'Beta.') });
  const { work, notes } = labelRead(f);
  const planSha = writeLabelPlan(work, { entries: [entryFor(notes, 'projects/p/b.md', 'work')], report: '# Labels\n' });
  writeLabelPlan(work, { entries: [entryFor(notes, 'projects/p/b.md', 'personal')], report: '# Labels\n' });
  // A session's note that is not committed yet: a step that synced would commit it.
  write(f.repo, 'projects/p/s.md', note('s', 'S', 'From a session.'));
  const head = f.head();
  const r = labelApply(f, work, planSha);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.result, {
    outcome: 'rejected', reason: 'label-plan.json was changed after it was written',
    written: [], unchanged: [], skipped: [], digests: {}, reportError: null, sync: null,
  });
  // A plan that is gone is refused the same way.
  rmSync(join(work, 'label-plan.json'));
  assert.equal(labelApply(f, work, planSha).result.outcome, 'rejected');
  assert.equal(liveText(f, 'projects/p/b.md'), note('b', 'B', 'Beta.'));
  assert.equal(f.head(), head);
  assert.match(sh(f.repo, 'git', ['status', '--porcelain']), /^\?\? projects\/p\/s\.md$/m);
  assert.deepEqual(f.reports(), []);
});

test('label-apply rejects a plan that is not well formed and writes nothing', (t) => {
  const f = fixture(t);
  f.seed({ 'projects/p/MEMORY.md': index('b.md'), 'projects/p/b.md': note('b', 'B', 'Beta.') });
  const { work, notes } = labelRead(f);
  const good = entryFor(notes, 'projects/p/b.md', 'work');
  const shape = /^label-plan\.json does not hold an entries list and a report text$/;
  const second = (what) => new RegExp(`^label-plan\\.json entry 2: ${what}$`);
  const notInScope = second('the path is not a note of global/ or of a project folder');
  const cases = [
    ['not JSON', '{"entries": [', /^label-plan\.json is not valid JSON$/],
    ['a list', '[]', shape],
    ['no report', { entries: [good] }, shape],
    ['entries that are not a list', { entries: good, report: '' }, shape],
    ['an entry that is not an object', { entries: [good, 'projects/p/b.md'], report: '' }, second('not an object')],
    ['the index', { entries: [good, { ...good, path: 'projects/p/MEMORY.md' }], report: '' }, second('MEMORY\\.md is the index, not a note')],
    ...['p/b.md', 'agents/a/b.md', 'projects/b.md', 'projects/p/sub/b.md', 'projects/../b.md', 'global/../b.md',
      '/projects/p/b.md', 'projects/p/b.txt']
      .map((path) => [path, { entries: [good, { ...good, path }], report: '' }, notInScope]),
    ...['projects/.p/b.md', 'projects/global/b.md']
      .map((path) => [path, { entries: [good, { ...good, path }], report: '' }, second('a project folder of that name is never labeled')]),
    ['an unknown label', { entries: [good, { ...good, label: 'Work' }], report: '' }, second('the label is not work, personal or general')],
    ['a digest that is not SHA-256', { entries: [good, { ...good, sha256: good.sha256.toUpperCase() }], report: '' },
      second('sha256 is not 64 hexadecimal characters')],
    ['a note listed twice', { entries: [good, { ...good, label: 'personal' }], report: '' }, second('the note is listed twice')],
  ];
  const head = f.head();
  for (const [what, plan, reason] of cases) {
    const r = labelApply(f, work, writeLabelPlan(work, plan));
    assert.equal(r.status, 0, `${what}: ${r.stderr}`);
    assert.equal(r.result.outcome, 'rejected', what);
    assert.match(r.result.reason, reason, what);
    assert.deepEqual([r.result.written, r.result.unchanged, r.result.skipped, r.result.sync], [[], [], [], null], what);
  }
  assert.equal(liveText(f, 'projects/p/b.md'), note('b', 'B', 'Beta.'));
  assert.equal(f.head(), head);
  assert.deepEqual(f.reports(), []);
});

test('label-apply that fails after its first write is apply-interrupted; before it, an error', { skip: asRoot && 'runs as root' }, (t) => {
  const f = fixture(t);
  f.seed({ 'projects/p/b.md': note('b', 'B', 'Beta.'), 'global/a.md': note('a', 'A', 'Alpha.') });
  const globalDir = join(f.repo, 'global');
  const withGlobalReadOnly = (fn) => {
    chmodSync(globalDir, 0o555);
    try {
      return fn();
    } finally {
      chmodSync(globalDir, 0o755);
    }
  };
  let { work, notes } = labelRead(f);
  let planSha = writeLabelPlan(work, {
    entries: [entryFor(notes, 'projects/p/b.md', 'work'), entryFor(notes, 'global/a.md', 'work')],
    report: '# Labels\n',
  });
  const head = f.head();
  let r = withGlobalReadOnly(() => labelApply(f, work, planSha));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.outcome, 'apply-interrupted');
  assert.match(r.result.reason, /EACCES/);
  // b.md was written and stays uncommitted (the next sync commits it); a.md was not.
  assert.equal(liveText(f, 'projects/p/b.md'), labeledNote('b', 'B', 'Beta.', 'work'));
  assert.deepEqual(r.result.written, [{ path: 'projects/p/b.md', sha256: sha(readFileSync(join(f.repo, 'projects/p/b.md'))) }]);
  assert.equal(liveText(f, 'global/a.md'), note('a', 'A', 'Alpha.'));
  assert.equal(f.head(), head);
  assert.deepEqual(f.reports(), []);
  assert.deepEqual(readdirSync(globalDir), ['a.md']);

  ({ work, notes } = labelRead(f));
  planSha = writeLabelPlan(work, {
    entries: [entryFor(notes, 'global/a.md', 'work'), entryFor(notes, 'projects/p/b.md', 'personal')],
    report: '# Labels\n',
  });
  r = withGlobalReadOnly(() => labelApply(f, work, planSha));
  assert.equal(r.status, 1);
  assert.equal(r.result.outcome, 'error');
  assert.match(r.result.error, /EACCES/);
  assert.equal(liveText(f, 'projects/p/b.md'), labeledNote('b', 'B', 'Beta.', 'work'));
});

test('label-apply finishes after SIGTERM, SIGINT or SIGHUP and reports its result', async (t) => {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const f = fixture(t);
    f.seed({ 'projects/p/b.md': note('b', 'B', 'Beta.') });
    const { work, notes } = labelRead(f);
    const planSha = writeLabelPlan(work, { entries: [entryFor(notes, 'projects/p/b.md', 'work')], report: '# Labels\n' });
    // The second fetch from here on is the sync after writing.
    const step = slowFetch(f, 2);
    const child = spawn(RUN_SH, ['consolidate-step', 'label-apply', '--work', work, '--plan-sha256', planSha],
      { env: f.env, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    const exited = new Promise((resolve) => child.once('close', (code, sig) => resolve({ code, signal: sig })));
    t.after(() => {
      step.release();
      child.kill('SIGKILL');
    });
    assert.ok(await waitFor(step.ready), `${signal}: the sync after writing is running`);
    process.kill(child.pid, signal);
    step.release();
    assert.deepEqual(await exited, { code: 0, signal: null }, signal);
    const res = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(res.outcome, 'applied', signal);
    assert.equal(res.sync.ok, true, signal);
    assert.equal(f.subjects()[0], 'consolidate(alpha): label 1 note(s) (2 file(s))', signal);
  }
});

test('label-read and label-apply stop when their first sync fails', (t) => {
  const f = fixture(t);
  f.seed({ 'projects/p/b.md': note('b', 'B', 'Beta.') });
  const { work, notes } = labelRead(f);
  const planSha = writeLabelPlan(work, { entries: [entryFor(notes, 'projects/p/b.md', 'work')], report: '# Labels\n' });
  sh(f.repo, 'git', ['remote', 'set-url', 'origin', join(f.tmp, 'no-such-remote.git')]);
  const read = labelWork(f);
  let r = runLabelStep(f, 'label-read', '--work', read);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.outcome, 'sync-failed');
  assert.equal(r.result.sync.ok, false);
  assert.deepEqual(readdirSync(read), []);
  r = labelApply(f, work, planSha);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.result.outcome, 'sync-failed');
  assert.equal(r.result.sync.ok, false);
  assert.deepEqual([r.result.written, r.result.unchanged, r.result.skipped], [[], [], []]);
  assert.equal(liveText(f, 'projects/p/b.md'), note('b', 'B', 'Beta.'));
  assert.deepEqual(f.reports(), []);
});

// ---- The label pass: run.sh consolidate label, and the pass at the end of every organize run ----

const LABEL_BLOCK = {
  model: 'example-label-model', region: 'us-east-1', credentials: 'environment', inputUsdPerMillion: 1.1, outputUsdPerMillion: 5.5,
};
const PERSONA = 'The owner works for an example company and has a family. Notes about the job are work.\n';
const NO_EXCEPTIONS = { version: 1, defaults: {}, exceptions: {} };
const LABEL_AWS_ENV = {
  AWS_ACCESS_KEY_ID: 'ASIAEXAMPLEKEYID0001', AWS_SECRET_ACCESS_KEY: 'example-signing-value', AWS_SESSION_TOKEN: 'example-session-value',
};

// A clone with both label inputs under .agent-memory/, a label block whose endpoint is the default
// Mantle host, and the fake Mantle of fake-mantle-preload.mjs in front of every run's fetch.
function labelFixture(t, { label = {}, consolidate = {}, domains = NO_EXCEPTIONS, persona = PERSONA } = {}) {
  const f = fixture(t, { consolidate: { label: { ...LABEL_BLOCK, ...label }, ...consolidate } });
  const mantleFile = join(f.tmp, 'mantle.json');
  const mantleLog = join(f.tmp, 'mantle.jsonl');
  writeFileSync(mantleFile, JSON.stringify({ labels: {} }));
  const inputs = {};
  if (domains !== null) inputs['.agent-memory/domains.json'] = `${JSON.stringify(domains)}\n`;
  if (persona !== null) inputs['.agent-memory/persona.md'] = persona;
  f.seed(inputs);
  const mantleEnv = {
    NODE_OPTIONS: `--import ${join(PKG, 'test', 'fake-mantle-preload.mjs')}`, FAKE_MANTLE_FILE: mantleFile, FAKE_MANTLE_LOG: mantleLog,
  };
  const labelEnv = { ...mantleEnv, ...LABEL_AWS_ENV };
  return {
    ...f, mantleEnv, labelEnv,
    mantle: (spec) => writeFileSync(mantleFile, JSON.stringify(spec)),
    requests: () => (existsSync(mantleLog) ? readFileSync(mantleLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    label: (...args) => f.runWith(labelEnv, 'label', ...args),
    organize: (...args) => f.runWith(labelEnv, 'organize', ...args),
    labelReport: () => liveText(f, `_reports/${today()}-alpha-label.md`),
  };
}

const digestIn = (f, rel) => sha(readFileSync(join(f.repo, rel)));

test('the first label run sends only unlabeled notes', (t) => {
  const f = labelFixture(t);
  f.seed({
    'projects/p/MEMORY.md': index('a.md', 'b.md', 'c.md'),
    'projects/p/a.md': labeledNote('a', 'A', 'Alpha.', 'work'),
    'projects/p/b.md': labeledNote('b', 'B', 'Beta.', 'general'),
    'projects/p/c.md': note('c', 'C', 'Gamma.'),
  });
  f.mantle({ labels: { 'projects/p/c.md': 'personal' } });
  const r = f.label();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.requests(), [{ paths: ['projects/p/c.md'], auth: true }]);
  assert.equal(liveText(f, 'projects/p/c.md'), labeledNote('c', 'C', 'Gamma.', 'personal'));
  assert.equal(liveText(f, 'projects/p/a.md'), labeledNote('a', 'A', 'Alpha.', 'work'));
  assert.deepEqual(f.readState().labels, {
    version: 1,
    notes: {
      'projects/p/a.md': digestIn(f, 'projects/p/a.md'),
      'projects/p/b.md': digestIn(f, 'projects/p/b.md'),
      'projects/p/c.md': digestIn(f, 'projects/p/c.md'),
    },
  });
  assert.equal(f.subjects()[0], 'consolidate(alpha): label 1 note(s) (2 file(s))');
  assert.equal(f.head(), sh(f.remote, 'git', ['rev-parse', 'main']).trim());
  assert.match(r.stdout, /^label: applied, 1 label\(s\) written, 0 unchanged, USD 0\.00, 1 request\(s\)$/m);
  // The terminal gets the labels without the model's reasons; the report in the clone has them.
  assert.match(r.stdout, /^- projects\/p\/c\.md: unlabeled → personal$/m);
  const report = f.labelReport();
  assert.match(report, new RegExp(`^# Labels — ${today()} on alpha$`, 'm'));
  assert.match(report, /^- Model: example-label-model; requests: 1; cost: USD 0\.00$/m);
  assert.match(report, /^- Notes: 1 touched, 1 sent to the model, 0 with an exception, 2 recorded as they were$/m);
  assert.match(report, /^## projects\/p\n\nLabels set or changed:\n- projects\/p\/c\.md: unlabeled → personal — fake reason for projects\/p\/c\.md$/m);
  assert.match(report, /^Labels after this run: 1 work, 1 personal, 1 general$/m);
  assert.doesNotMatch(r.stdout + r.stderr + report, /ASIAEXAMPLE|example-signing|example-session/);
  assert.deepEqual(readdirSync(f.workRoot()), []);
});

test('an unchanged store sends nothing', (t) => {
  const f = labelFixture(t);
  f.seed({ 'projects/p/a.md': labeledNote('a', 'A', 'Alpha.', 'work'), 'projects/p/c.md': note('c', 'C', 'Gamma.') });
  assert.equal(f.label().status, 0);
  assert.equal(f.requests().length, 1);
  const head = f.head();
  const state = readFileSync(f.stateFile(), 'utf8');
  const r = f.label();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'label: nothing to do\n');
  assert.equal(f.requests().length, 1);
  assert.equal(f.head(), head);
  assert.equal(readFileSync(f.stateFile(), 'utf8'), state);
});

test('a persona change sends nothing', (t) => {
  const f = labelFixture(t);
  f.seed({ 'projects/p/c.md': note('c', 'C', 'Gamma.') });
  assert.equal(f.label().status, 0);
  f.seed({ '.agent-memory/persona.md': `${PERSONA}Notes about the family are personal.\n` });
  const head = f.head();
  const r = f.label();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'label: nothing to do\n');
  assert.equal(f.requests().length, 1);
  assert.equal(f.head(), head);
});

test('an edited note is sent again', (t) => {
  const f = labelFixture(t);
  f.seed({ 'projects/p/a.md': labeledNote('a', 'A', 'Alpha.', 'work'), 'projects/p/c.md': note('c', 'C', 'Gamma.') });
  assert.equal(f.label().status, 0);
  // A session edits a.md: it is touched, whatever label it carries. c.md is deleted.
  rmSync(join(f.repo, 'projects/p/c.md'));
  f.seed({ 'projects/p/a.md': labeledNote('a', 'A', 'Alpha, now about the family.', 'work') });
  f.mantle({ labels: { 'projects/p/a.md': 'personal' } });
  const r = f.label('--model', 'other-label-model');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.requests().map((q) => q.paths), [['projects/p/c.md'], ['projects/p/a.md']]);
  assert.equal(liveText(f, 'projects/p/a.md'), labeledNote('a', 'A', 'Alpha, now about the family.', 'personal'));
  // The record follows: the new digest of a.md, and no entry for the note that is gone.
  assert.deepEqual(f.readState().labels.notes, { 'projects/p/a.md': digestIn(f, 'projects/p/a.md') });
  // --model names the label model of this run.
  assert.match(f.labelReport(), /^- Model: other-label-model; requests: 1;/m);
  assert.match(f.labelReport(), /^- projects\/p\/a\.md: work → personal — fake reason for projects\/p\/a\.md$/m);
});

test('label --all sends every note', (t) => {
  const f = labelFixture(t);
  f.seed({
    'global/g.md': labeledNote('g', 'G', 'General.', 'general'),
    'projects/p/a.md': labeledNote('a', 'A', 'Alpha.', 'work'),
    'projects/p/c.md': note('c', 'C', 'Gamma.'),
  });
  assert.equal(f.label().status, 0);
  assert.deepEqual(f.requests().map((q) => q.paths), [['projects/p/c.md']]);
  // The model gives every note the label it has: nothing is written.
  f.mantle({ labels: { 'projects/p/a.md': 'work' } });
  const head = f.head();
  const r = f.label('--all');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.requests().slice(1).map((q) => q.paths), [['global/g.md'], ['projects/p/a.md', 'projects/p/c.md']]);
  assert.match(r.stdout, /^label: no-change, 0 label\(s\) written, 3 unchanged, USD 0\.00, 2 request\(s\)$/m);
  assert.equal(f.head(), head);
  // A named scope only; the record keeps the entries of the scopes the run did not read.
  const p = f.label('--all', '--project', 'p');
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.deepEqual(f.requests().at(-1).paths, ['projects/p/a.md', 'projects/p/c.md']);
  assert.equal(f.requests().length, 4);
  assert.deepEqual(Object.keys(f.readState().labels.notes), ['global/g.md', 'projects/p/a.md', 'projects/p/c.md']);
});

test('an exception labels its note without the model', (t) => {
  const domains = {
    version: 1, defaults: {},
    exceptions: { 'projects/p/a.md': 'personal', 'projects/p/c.md': 'work', 'projects/p/gone.md': 'general', 'projects/q/x.md': 'work' },
  };
  const f = labelFixture(t, { domains });
  f.seed({
    'projects/p/a.md': labeledNote('a', 'A', 'Alpha.', 'work'),
    'projects/p/b.md': labeledNote('b', 'B', 'Beta.', 'general'),
    'projects/p/c.md': note('c', 'C', 'Gamma.'),
    'projects/q/y.md': labeledNote('y', 'Y', 'Why.', 'work'),
  });
  // No AWS credentials: with no batch to send, no token is asked for.
  const r = f.runWith(f.mantleEnv, 'label', '--project', 'p');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.requests(), []);
  assert.equal(liveText(f, 'projects/p/a.md'), labeledNote('a', 'A', 'Alpha.', 'personal'));
  assert.equal(liveText(f, 'projects/p/c.md'), labeledNote('c', 'C', 'Gamma.', 'work'));
  assert.match(r.stdout, /^label: applied, 2 label\(s\) written, 0 unchanged, USD 0\.00, 0 request\(s\)$/m);
  const report = f.labelReport();
  assert.match(report, /^- projects\/p\/a\.md: work → personal \(exception\)$/m);
  assert.match(report, /^- projects\/p\/c\.md: unlabeled → work \(exception\)$/m);
  assert.match(report, /^Exceptions that name no note:\n- projects\/p\/gone\.md$/m);
  // projects/q is not a scope of this run: its exception is not reported.
  assert.doesNotMatch(report, /projects\/q/);
  // The first run records every label of the store as it is, also outside the named scopes.
  assert.deepEqual(f.readState().labels.notes, {
    'projects/p/a.md': digestIn(f, 'projects/p/a.md'),
    'projects/p/b.md': digestIn(f, 'projects/p/b.md'),
    'projects/p/c.md': digestIn(f, 'projects/p/c.md'),
    'projects/q/y.md': digestIn(f, 'projects/q/y.md'),
  });
  // The model never sees a note with an exception, not even with --all.
  const all = f.label('--all', '--project', 'p');
  assert.equal(all.status, 0, all.stdout + all.stderr);
  assert.deepEqual(f.requests(), [{ paths: ['projects/p/b.md'], auth: true }]);
  assert.match(all.stdout, /^label: no-change, 0 label\(s\) written, 3 unchanged, USD 0\.00, 1 request\(s\)$/m);
});

test('labels do not make a scope due for Organize', (t) => {
  const f = labelFixture(t);
  f.seed({
    'projects/p/MEMORY.md': index('a.md', 'b.md'),
    'projects/p/a.md': note('a', 'A', 'Alpha.'),
    'projects/p/b.md': labeledNote('b', 'B', 'Beta.', 'work'),
  });
  // The model finds nothing to change; the label pass at the end of the run labels a.md.
  let r = f.organize();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^organize p: no-change/m);
  assert.match(r.stdout, /^label: applied, 1 label\(s\) written/m);
  assert.equal(f.readState().projects.p.organizedDigest, folderDigest(join(f.repo, 'projects/p')));
  r = f.organize();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^organize: nothing to do$/m);
  assert.equal(f.calls().length, 1);
  // An exception added later: label writes it, and Organize's record moves with it.
  f.seed({ '.agent-memory/domains.json': `${JSON.stringify({ ...NO_EXCEPTIONS, exceptions: { 'projects/p/b.md': 'personal' } })}\n` });
  r = f.label();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(liveText(f, 'projects/p/b.md'), labeledNote('b', 'B', 'Beta.', 'personal'));
  assert.equal(f.subjects()[0], 'consolidate(alpha): label 1 note(s) (2 file(s))');
  r = f.organize();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^organize: nothing to do$/m);
  assert.equal(f.calls().length, 1);
});

test('a scope that was due before labeling stays due', (t) => {
  const f = labelFixture(t);
  f.seed({ 'projects/p/a.md': note('a', 'A', 'Alpha.'), 'projects/q/b.md': note('b', 'B', 'Beta.') });
  assert.equal(f.organize().status, 0);
  assert.deepEqual(f.calls().map((c) => c.scope), ['p', 'q']);
  // A session rewrites b.md without its label: q is due for Organize, and b.md is touched.
  f.seed({ 'projects/q/b.md': note('b', 'B', 'Beta, rewritten.') });
  f.mantle({ labels: { 'projects/q/b.md': 'work' } });
  const r = f.label();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(liveText(f, 'projects/q/b.md'), labeledNote('b', 'B', 'Beta, rewritten.', 'work'));
  assert.equal(f.organize().status, 0);
  assert.deepEqual(f.calls().map((c) => c.scope), ['p', 'q', 'q']);
});

test('organize ends with the label pass', (t) => {
  const f = labelFixture(t);
  f.seed({ 'projects/p/MEMORY.md': index('a.md'), 'projects/p/a.md': labeledNote('a', 'A', 'Alpha.', 'work') });
  // The model adds a note; the label pass that follows sends it.
  f.instruct({ p: { writes: { 'notes/n.md': note('n', 'New', 'A new note.'), 'notes/MEMORY.md': index('a.md', 'n.md') } } });
  f.mantle({ labels: { 'projects/p/n.md': 'personal' } });
  const r = f.organize('--model', 'other-model');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [call] = f.calls();
  assert.equal(f.calls().length, 1);
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'other-model');
  assert.deepEqual(f.requests(), [{ paths: ['projects/p/n.md'], auth: true }]);
  assert.match(r.stdout, /^organize p: applied, 2 change\(s\)[^\n]*\nlabel: applied, 1 label\(s\) written/m);
  assert.equal(liveText(f, 'projects/p/n.md'), labeledNote('n', 'New', 'A new note.', 'personal'));
  // --model of an organize run names the Organize model only.
  assert.match(f.labelReport(), /^- Model: example-label-model;/m);
  assert.match(f.subjects()[0], /^consolidate\(alpha\): label 1 note\(s\) \(2 file\(s\)\)$/);
  assert.match(f.subjects()[1], /^consolidate\(alpha\): organize projects\/p /);
});

test('missing inputs stop the pass', (t) => {
  const f = labelFixture(t, { persona: null });
  f.seed({ 'projects/p/c.md': note('c', 'C', 'Gamma.') });
  const line = 'label: the label inputs are missing or invalid (personaFile); no label was written.\n';
  const head = f.head();
  let r = f.label();
  assert.equal(r.status, 1);
  assert.equal(r.stdout, line);
  assert.equal(f.head(), head);
  // After an Organize run that succeeded, too.
  r = f.organize();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^organize p: no-change/m);
  assert.ok(r.stdout.endsWith(line), r.stdout);
  assert.deepEqual(f.requests(), []);
  assert.equal(liveText(f, 'projects/p/c.md'), note('c', 'C', 'Gamma.'));
  assert.equal(f.readState().labels, undefined);
  // A domains file that is not valid is named with its problem.
  f.seed({ '.agent-memory/persona.md': PERSONA, '.agent-memory/domains.json': '{"version": 2}\n' });
  r = f.label();
  assert.equal(r.status, 1);
  assert.equal(r.stdout, 'label: the label inputs are missing or invalid (domainsFile: version); no label was written.\n');
  // Inputs named in the label block are read from there instead.
  const domainsFile = join(f.tmp, 'domains.json');
  const personaFile = join(f.tmp, 'persona.md');
  writeFileSync(domainsFile, JSON.stringify(NO_EXCEPTIONS));
  writeFileSync(personaFile, PERSONA);
  f.setConfig({ label: { ...LABEL_BLOCK, domainsFile, personaFile } });
  r = f.label();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.requests(), [{ paths: ['projects/p/c.md'], auth: true }]);
  // A clone that is missing is the read step's error.
  const config = JSON.parse(readFileSync(f.configFile, 'utf8'));
  writeFileSync(f.configFile, JSON.stringify({ ...config, repoDir: join(f.tmp, 'nowhere') }));
  r = f.label();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^ {2}- the label-read step failed: the notes clone \S+ does not exist$/m);
});

test('a failed batch leaves its notes for the next run', (t) => {
  const f = labelFixture(t);
  f.seed({ 'global/g.md': note('g', 'G', 'General.'), 'projects/p/a.md': note('a', 'A', 'Alpha.'), 'projects/q/c.md': note('c', 'C', 'Gamma.') });
  // The first batch (global/) fails on each of its attempts; the pass goes on with the two others.
  f.mantle({ labels: { 'global/g.md': 'work', 'projects/p/a.md': 'personal', 'projects/q/c.md': 'personal' }, fail: { status: 500, times: 3 } });
  const r = f.label();
  assert.equal(r.status, 1);
  assert.deepEqual(f.requests().map((q) => q.paths),
    [['global/g.md'], ['global/g.md'], ['global/g.md'], ['projects/p/a.md'], ['projects/q/c.md']]);
  assert.doesNotMatch(r.stdout, /^label: stopped/m);
  assert.equal(liveText(f, 'global/g.md'), note('g', 'G', 'General.'));
  assert.equal(liveText(f, 'projects/p/a.md'), labeledNote('a', 'A', 'Alpha.', 'personal'));
  assert.equal(liveText(f, 'projects/q/c.md'), labeledNote('c', 'C', 'Gamma.', 'personal'));
  assert.deepEqual(Object.keys(f.readState().labels.notes), ['projects/p/a.md', 'projects/q/c.md']);
  assert.match(r.stdout, /^label: applied, 2 label\(s\) written, 0 unchanged, USD 0\.00, 3 request\(s\)$/m);
  assert.match(r.stdout, /^- global\/g\.md: the model call failed \(Mantle Responses HTTP 500\)$/m);
  const report = f.labelReport();
  assert.match(report, /^Left for the next run:\n- global\/g\.md: the model call failed \(Mantle Responses HTTP 500\)$/m);
  assert.doesNotMatch(r.stdout + r.stderr + report, /FAKE-MANTLE-BODY/);
  // The next run sends what was left, and only that.
  f.mantle({ labels: { 'global/g.md': 'work' } });
  const again = f.label();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(f.requests().length, 6);
  assert.deepEqual(f.requests().at(-1).paths, ['global/g.md']);
  assert.equal(liveText(f, 'global/g.md'), labeledNote('g', 'G', 'General.', 'work'));
});

test('two failed batches in a row stop the pass', (t) => {
  const f = labelFixture(t);
  f.seed({
    'global/g.md': note('g', 'G', 'General.'), 'projects/p/a.md': note('a', 'A', 'Alpha.'),
    'projects/q/b.md': note('b', 'B', 'Beta.'), 'projects/r/c.md': note('c', 'C', 'Gamma.'),
  });
  // The first batch is answered; the next two fail on each of their attempts.
  f.mantle({ labels: { 'global/g.md': 'work' }, fail: { status: 500, times: 6, after: 1 } });
  const r = f.label();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^label: stopped; 2 batches in a row failed$/m);
  // The fourth batch is never sent.
  assert.deepEqual(f.requests().map((q) => q.paths),
    [['global/g.md'], ...Array(3).fill(['projects/p/a.md']), ...Array(3).fill(['projects/q/b.md'])]);
  // The batch answered before is written and recorded; the others stay touched.
  assert.equal(liveText(f, 'global/g.md'), labeledNote('g', 'G', 'General.', 'work'));
  assert.equal(liveText(f, 'projects/r/c.md'), note('c', 'C', 'Gamma.'));
  assert.deepEqual(Object.keys(f.readState().labels.notes), ['global/g.md']);
  const report = f.labelReport();
  assert.match(report, /^- projects\/p\/a\.md: the model call failed \(Mantle Responses HTTP 500\)$/m);
  assert.match(report, /^- projects\/q\/b\.md: the model call failed \(Mantle Responses HTTP 500\)$/m);
  assert.match(report, /^- projects\/r\/c\.md: not sent; 2 batches in a row failed$/m);
  assert.doesNotMatch(r.stdout + r.stderr + report, /FAKE-MANTLE-BODY/);
});

test('the token age stops the pass', (t) => {
  const f = labelFixture(t);
  f.seed({ 'global/g.md': note('g', 'G', 'General.'), 'projects/p/a.md': note('a', 'A', 'Alpha.'), 'projects/q/b.md': note('b', 'B', 'Beta.') });
  // Each request moves the driver's clock 30 minutes on: the third batch would start with a token an hour old.
  f.mantle({ labels: { 'global/g.md': 'work', 'projects/p/a.md': 'personal' }, advanceMs: 30 * 60 * 1000 });
  const r = f.label();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^label: stopped; the label token of this run is near the end of its hour$/m);
  assert.deepEqual(f.requests().map((q) => q.paths), [['global/g.md'], ['projects/p/a.md']]);
  assert.equal(liveText(f, 'projects/p/a.md'), labeledNote('a', 'A', 'Alpha.', 'personal'));
  assert.equal(liveText(f, 'projects/q/b.md'), note('b', 'B', 'Beta.'));
  assert.deepEqual(Object.keys(f.readState().labels.notes), ['global/g.md', 'projects/p/a.md']);
  assert.match(f.labelReport(), /^- projects\/q\/b\.md: not sent; the label token of this run was near the end of its hour$/m);
});

test('an --all run that stops leaves its notes to the next run', (t) => {
  const f = labelFixture(t);
  f.seed({
    'global/g.md': labeledNote('g', 'G', 'General.', 'general'),
    'projects/p/a.md': labeledNote('a', 'A', 'Alpha.', 'work'),
    'projects/q/b.md': labeledNote('b', 'B', 'Beta.', 'personal'),
  });
  // A first run records the three labels as they are.
  assert.equal(f.label().status, 0);
  assert.deepEqual(f.requests(), []);
  // A full relabel whose first batch reaches the ceiling.
  f.setConfig({ maxBudgetUsd: 0.001 });
  f.mantle({ labels: { 'global/g.md': 'work', 'projects/p/a.md': 'work', 'projects/q/b.md': 'personal' } });
  const all = f.label('--all');
  assert.equal(all.status, 0, all.stdout + all.stderr);
  assert.match(all.stdout, /^label: stopped; the model cost of this run reached its ceiling of USD 0\.00$/m);
  assert.deepEqual(f.requests().map((q) => q.paths), [['global/g.md']]);
  assert.equal(liveText(f, 'global/g.md'), labeledNote('g', 'G', 'General.', 'work'));
  // The notes it did not reach lose their entries, which still matched them.
  assert.deepEqual(Object.keys(f.readState().labels.notes), ['global/g.md']);
  // A plain run sends exactly those notes.
  f.setConfig();
  const next = f.label();
  assert.equal(next.status, 0, next.stdout + next.stderr);
  assert.deepEqual(f.requests().slice(1).map((q) => q.paths), [['projects/p/a.md'], ['projects/q/b.md']]);
  assert.deepEqual(Object.keys(f.readState().labels.notes), ['global/g.md', 'projects/p/a.md', 'projects/q/b.md']);
});

test('a dry run writes nothing', (t) => {
  const f = labelFixture(t);
  f.seed({ 'projects/p/a.md': labeledNote('a', 'A', 'Alpha.', 'work'), 'projects/p/c.md': note('c', 'C', 'Gamma.') });
  f.mantle({ labels: { 'projects/p/c.md': 'personal' } });
  const head = f.head();
  const r = f.label('--dry-run', '--keep');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^label: dry-run, 1 label\(s\) to set or change, USD 0\.00, 1 request\(s\)$/m);
  assert.match(r.stdout, /^- projects\/p\/c\.md: unlabeled → personal — fake reason for projects\/p\/c\.md$/m);
  assert.deepEqual(f.requests(), [{ paths: ['projects/p/c.md'], auth: true }]);
  assert.equal(liveText(f, 'projects/p/c.md'), note('c', 'C', 'Gamma.'));
  assert.equal(f.head(), head);
  assert.deepEqual(f.reports(), []);
  assert.equal(existsSync(f.stateFile()), false);
  // --keep keeps the work folder: the notes as they were read, and no plan.
  const kept = /^ {2}work folder kept: (.+)$/m.exec(r.stdout)?.[1];
  assert.ok(kept && existsSync(join(kept, 'label-notes.json')), r.stdout);
  assert.equal(existsSync(join(kept, 'label-plan.json')), false);
});

test('the cost ceiling stops the pass', (t) => {
  const f = labelFixture(t, { consolidate: { maxBudgetUsd: 0.001 } });
  f.seed({ 'global/g.md': note('g', 'G', 'General.'), 'projects/q/c.md': note('c', 'C', 'Gamma.') });
  f.mantle({ labels: { 'global/g.md': 'work', 'projects/q/c.md': 'personal' } });
  const r = f.label();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^label: stopped; the model cost of this run reached its ceiling of USD 0\.00$/m);
  assert.deepEqual(f.requests().map((q) => q.paths), [['global/g.md']]);
  assert.equal(liveText(f, 'global/g.md'), labeledNote('g', 'G', 'General.', 'work'));
  assert.equal(liveText(f, 'projects/q/c.md'), note('c', 'C', 'Gamma.'));
  assert.deepEqual(Object.keys(f.readState().labels.notes), ['global/g.md']);
  assert.match(f.labelReport(), /^- projects\/q\/c\.md: not sent; the model cost of this run reached its ceiling$/m);
});

test('label without the block says so', (t) => {
  const f = fixture(t);
  f.seed({ 'projects/p/c.md': note('c', 'C', 'Gamma.') });
  const head = f.head();
  const r = f.run('label');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, `agent-memory: labeling needs "label" in the consolidate block of ${f.configFile}; nothing was run.\n`);
  assert.equal(f.head(), head);
  // An organize run without the block ends without a label pass.
  const o = f.run('organize');
  assert.equal(o.status, 0, o.stdout + o.stderr);
  assert.doesNotMatch(o.stdout, /^label/m);
});

test('a note that Organize must repair first is never sent to the model', (t) => {
  const f = labelFixture(t);
  const latin1 = Buffer.concat([Buffer.from(note('l', 'L', 'Caf').trimEnd()), Buffer.from([0xe9, 0x0a])]);
  f.seed({ 'projects/p/plain.md': 'Just a line, no frontmatter.\n', 'projects/p/latin.md': latin1, 'projects/p/c.md': note('c', 'C', 'Gamma.') });
  const r = f.label();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.requests(), [{ paths: ['projects/p/c.md'], auth: true }]);
  assert.equal(liveText(f, 'projects/p/plain.md'), 'Just a line, no frontmatter.\n');
  assert.ok(readFileSync(join(f.repo, 'projects/p/latin.md')).equals(latin1));
  assert.deepEqual(Object.keys(f.readState().labels.notes), ['projects/p/c.md']);
  const repair = /^Left for Organize's repair:\n- projects\/p\/latin\.md: not UTF-8 text\n- projects\/p\/plain\.md: no frontmatter$/m;
  assert.match(f.labelReport(), repair);
  // They are named on every run until Organize repairs them, and never sent.
  const again = f.label();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^label: nothing to do$/m);
  assert.match(again.stdout, repair);
  assert.equal(f.requests().length, 1);
});

test('a signal during the label model call writes nothing', async (t) => {
  for (const [args, kind] of [[['label'], 'label'], [['organize'], 'organize']]) {
    const f = labelFixture(t);
    f.seed({ 'projects/p/c.md': note('c', 'C', 'Gamma.') });
    f.mantle({ labels: { 'projects/p/c.md': 'work' }, delayMs: 20000 });
    const child = spawn(RUN_SH, ['consolidate', ...args], { env: { ...f.env, ...f.labelEnv }, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    const exited = new Promise((resolve) => child.once('close', (code, sig) => resolve({ code, signal: sig })));
    t.after(() => child.kill('SIGKILL'));
    assert.ok(await waitFor(() => f.requests().length === 1), `${kind}: the model was asked`);
    const head = f.head();
    child.kill('SIGTERM');
    assert.deepEqual(await exited, { code: 143, signal: null }, kind);
    assert.match(stdout, new RegExp(`^${kind}: interrupted by SIGTERM; nothing more was applied$`, 'm'));
    assert.doesNotMatch(stdout, /^label: (applied|no-change|nothing)/m, kind);
    assert.equal(liveText(f, 'projects/p/c.md'), note('c', 'C', 'Gamma.'), kind);
    assert.equal(f.head(), head, kind);
    assert.equal(existsSync(f.stateFile()) ? f.readState().labels : undefined, undefined, kind);
    assert.deepEqual(readdirSync(f.workRoot()), [], kind);
    assert.ok(lockIsFree(f), kind);
  }
});

test('label: usage errors, and a named project without a folder', (t) => {
  const f = labelFixture(t);
  const cases = [
    ['organize', '--all'], ['extract', '--all'], ['label', '--min-retention', '0.5'], ['label', '--agents', '--project', 'p'],
    ['label', '--agent', 'example-agent', '--keep'], ['label', '--project'], ['label', '--project', '../p'], ['label', '--model', '-x'],
  ];
  for (const args of cases) {
    const r = f.runWith(f.labelEnv, ...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^usage: .*\| label \[--project <name>\]\.\.\. \[--all\] \[--dry-run\] \[--keep\] \[--model <id>\] \| label --agents \[--agent <name>\]\.\.\. \[--all\] \[--dry-run\]$/m, args.join(' '));
  }
  const r = f.label('--project', 'gone');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, 'label: no folder for project gone; nothing labeled there.\nlabel: nothing to do\n');
  assert.deepEqual(f.requests(), []);
});

test('failed answers do not stop the pass', (t) => {
  const f = labelFixture(t);
  f.seed({
    'global/g.md': note('g', 'G', 'General.'), 'projects/p/a.md': note('a', 'A', 'Alpha.'),
    'projects/q/b.md': note('b', 'B', 'Beta.'), 'projects/r/c.md': note('c', 'C', 'Gamma.'),
  });
  // The first two batches get an answer that is a failure (HTTP 400, not retried): the endpoint
  // is in reach, so the batches after them are still sent.
  f.mantle({ labels: { 'projects/q/b.md': 'work', 'projects/r/c.md': 'personal' }, fail: { status: 400, times: 2 } });
  const r = f.label();
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /^label: stopped/m);
  assert.deepEqual(f.requests().map((q) => q.paths), [['global/g.md'], ['projects/p/a.md'], ['projects/q/b.md'], ['projects/r/c.md']]);
  assert.equal(liveText(f, 'projects/q/b.md'), labeledNote('b', 'B', 'Beta.', 'work'));
  assert.equal(liveText(f, 'projects/r/c.md'), labeledNote('c', 'C', 'Gamma.', 'personal'));
  assert.deepEqual(Object.keys(f.readState().labels.notes), ['projects/q/b.md', 'projects/r/c.md']);
  assert.match(r.stdout, /^- global\/g\.md: the model call failed \(Mantle Responses HTTP 400\)$/m);
  assert.doesNotMatch(r.stdout + r.stderr, /FAKE-MANTLE-BODY/);
});

test('a batch whose answer fails is split, and labels its notes when its halves are answered', (t) => {
  const f = labelFixture(t);
  f.seed({ 'projects/p/a.md': note('a', 'A', 'Alpha.'), 'projects/p/b.md': note('b', 'B', 'Beta.'), 'projects/p/c.md': note('c', 'C', 'Gamma.') });
  f.mantle({ labels: { 'projects/p/a.md': 'work', 'projects/p/b.md': 'work', 'projects/p/c.md': 'personal' }, fail: { status: 400, times: 1 } });
  const r = f.label();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.requests().map((q) => q.paths), [['projects/p/a.md', 'projects/p/b.md', 'projects/p/c.md'], ['projects/p/a.md', 'projects/p/b.md'], ['projects/p/c.md']]);
  assert.match(r.stdout, /^label: applied, 3 label\(s\) written, 0 unchanged, USD 0\.00, 3 request\(s\)$/m);
  assert.equal(liveText(f, 'projects/p/c.md'), labeledNote('c', 'C', 'Gamma.', 'personal'));
  assert.deepEqual(Object.keys(f.readState().labels.notes), ['projects/p/a.md', 'projects/p/b.md', 'projects/p/c.md']);
  assert.match(f.labelReport(), /^- Notes: 3 touched, 3 sent to the model, 0 with an exception, 0 recorded as they were$/m);
});

// ---- The label pass over the agent scopes: label --agents, and the end of every organize --agents run ----

// The agent scopes' bucket (fake-s3-preload.mjs) and a label block, with the fake Mantle
// (fake-mantle-preload.mjs) in front of the same run's fetch. The label inputs are in the clone;
// `writeConfig` can name them in the label block instead, and leave the run without a clone, as in
// a GitHub Actions job.
function agentLabelFixture(t, { label = LABEL_BLOCK, domains = NO_EXCEPTIONS, block = AGENTS_BLOCK } = {}) {
  const f = agentsFixture(t, { block, consolidate: label === null ? {} : { label } });
  const mantleFile = join(f.tmp, 'mantle.json');
  const mantleLog = join(f.tmp, 'mantle.jsonl');
  writeFileSync(mantleFile, JSON.stringify({ labels: {} }));
  f.seed({ '.agent-memory/domains.json': `${JSON.stringify(domains)}\n`, '.agent-memory/persona.md': PERSONA });
  const env = {
    ...f.awsEnv,
    NODE_OPTIONS: `--import ${join(PKG, 'test', 'fake-s3-preload.mjs')} --import ${join(PKG, 'test', 'fake-mantle-preload.mjs')}`,
    FAKE_MANTLE_FILE: mantleFile, FAKE_MANTLE_LOG: mantleLog,
  };
  const clientEnv = { FAKE_INSTRUCTIONS: join(f.tmp, 'instructions.json'), FAKE_CALLS: join(f.tmp, 'calls.jsonl'), FAKE_SUMMARY: SUMMARY, FAKE_S3_FILE: f.bucketFile };
  return {
    ...f,
    mantle: (spec) => writeFileSync(mantleFile, JSON.stringify(spec)),
    requests: () => (existsSync(mantleLog) ? readFileSync(mantleLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    organizeAgents: (...args) => f.runWith(env, 'organize', '--agents', ...args),
    labelAgents: (...args) => f.runWith(env, 'label', '--agents', ...args),
    state: (agent) => JSON.parse(f.bucket()['index/organizer.json']).scopes[agent],
    entry: (path) => JSON.parse(f.bucket()['index/agents.json']).notes.find((n) => n.path === path),
    writeConfig({ label: block = label, clone = true } = {}) {
      f.setConfig({ env: clientEnv, label: block });
      if (!clone) {
        const config = JSON.parse(readFileSync(f.configFile, 'utf8'));
        writeFileSync(f.configFile, JSON.stringify({ ...config, repoDir: join(f.tmp, 'no-notes-clone') }));
      }
    },
    // An agent's write through the memory API: the search entry first, then the note.
    agentWrites(name, description, content) {
      const objects = JSON.parse(readFileSync(f.bucketFile, 'utf8'));
      const path = `agents/codex-alpha/${name}.md`;
      const doc = JSON.parse(Buffer.from(objects['index/agents.json'].body, 'base64').toString('utf8'));
      doc.notes = [...doc.notes.filter((n) => n.path !== path), { path, name, description, type: 'reference', body: content }]
        .sort((x, y) => (x.path < y.path ? -1 : 1));
      for (const [key, text] of [['index/agents.json', JSON.stringify(doc)], [path, apiNote(name, description, content)]]) {
        objects[key] = { body: Buffer.from(text).toString('base64'), etag: md5(text) };
      }
      writeFileSync(f.bucketFile, JSON.stringify(objects));
    },
  };
}

const agentLabeled = (text, label) => text.replace('  type: reference\n', `  type: reference\n  domain: ${label}\n`);

test('organize --agents ends with the label pass', (t) => {
  const f = agentLabelFixture(t);
  // Organize merges the two notes into one; the label pass that follows sends the note it left.
  f.instruct(agentMerge());
  f.mantle({ labels: { 'agents/codex-alpha/deploys.md': 'work' } });
  const r = f.organizeAgents('--model', 'other-model');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [call] = f.calls();
  assert.equal(f.calls().length, 1);
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'other-model');
  assert.deepEqual(f.requests(), [{ paths: ['agents/codex-alpha/deploys.md'], auth: true }]);
  assert.match(r.stdout, /^organize agents\/codex-alpha: applied, 3 change\(s\)/m);
  assert.ok(r.stdout.indexOf('organize agents/codex-alpha: applied') < r.stdout.indexOf('label agents/codex-alpha:'), r.stdout);
  assert.match(r.stdout, /^label: 1 note\(s\) sent to the model, USD 0\.00, 1 request\(s\)\nlabel agents\/codex-alpha: applied, 1 label\(s\) written, 0 unchanged$/m);
  assert.match(r.stdout, /^- agents\/codex-alpha\/deploys\.md: unlabeled → work$/m);
  // The label is in the note and in its search entry, and the scope's record holds what the pass saw.
  const b = f.bucket();
  assert.equal(b['agents/codex-alpha/deploys.md'], agentLabeled(MERGED_DEPLOYS, 'work'));
  assert.equal(f.entry('agents/codex-alpha/deploys.md').domain, 'work');
  const state = f.state('codex-alpha');
  assert.deepEqual(state.labels, { 'deploys.md': md5(agentLabeled(MERGED_DEPLOYS, 'work')) });
  assert.match(state.lastLabel, /^\d{4}-\d\d-\d\dT/);
  assert.equal(state.lastOutcome.outcome, 'applied');
  // Labels never make the scope due: the next run has nothing to organize and nothing to label.
  const again = f.organizeAgents();
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^organize: nothing to do\nlabel agents\/codex-alpha: nothing to do$/m);
  assert.equal(f.calls().length, 1);
  assert.equal(f.requests().length, 1);
  // Every write was conditional and within what the organizer role may write; the label model's
  // reasons and the token reach no output, and the model client never saw the token or the job's
  // credentials.
  for (const w of writes(f.log())) {
    assert.ok(w.ifMatch !== null || w.ifNoneMatch === '*', `${w.method} ${w.key}`);
    assert.match(w.key, /^(?:agents\/[^/]+\/[^/]+\.md|index\/agents\.json|index\/organizer\.json)$/);
  }
  assert.doesNotMatch(r.stdout + r.stderr, /fake reason|bedrock-api-key|ASIAEXAMPLE|example-signing/);
  assert.doesNotMatch(JSON.stringify(f.calls()), /bedrock-api-key|ASIAEXAMPLE|example-signing/);
  // A dry run of organize --agents ends with a dry run of the pass: the model is asked, nothing is written.
  f.agentWrites('deploys', 'How deploys go now', 'Deploys now go through a canary first.');
  f.instruct({});
  const logged = writes(f.log()).length;
  const dry = f.organizeAgents('--dry-run');
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  assert.match(dry.stdout, /^label agents\/codex-alpha: dry-run, 1 label\(s\) to set or change$/m);
  assert.equal(f.requests().length, 2);
  assert.equal(writes(f.log()).length, logged);
});

test('label --agents --all sends every agent note', (t) => {
  const exceptions = { 'agents/codex-alpha/deploy-steps.md': 'personal' };
  const f = agentLabelFixture(t, { domains: { ...NO_EXCEPTIONS, exceptions } });
  f.mantle({ labels: { 'agents/codex-alpha/deploys.md': 'work' } });
  // A first run: the note with an exception is labeled by code, the other by the model.
  let r = f.labelAgents();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.requests(), [{ paths: ['agents/codex-alpha/deploys.md'], auth: true }]);
  assert.match(r.stdout, /^label agents\/codex-alpha: applied, 2 label\(s\) written, 0 unchanged$/m);
  assert.match(r.stdout, /^- agents\/codex-alpha\/deploy-steps\.md: unlabeled → personal \(exception\)$/m);
  assert.equal(f.calls().length, 0, 'label --agents runs no Organize');
  // A plain run sends nothing.
  r = f.labelAgents();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.requests().length, 1);
  assert.match(r.stdout, /^label agents\/codex-alpha: no-change, 0 label\(s\) written, 1 unchanged$/m);
  // --all sends every note but the exception's, whatever the record says; labels that hold are not written.
  const notes = () => Object.entries(f.bucket()).filter(([key]) => key.startsWith('agents/'));
  const before = notes();
  r = f.labelAgents('--all');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.requests().slice(1), [{ paths: ['agents/codex-alpha/deploys.md'], auth: true }]);
  assert.match(r.stdout, /^label agents\/codex-alpha: no-change, 0 label\(s\) written, 2 unchanged$/m);
  assert.deepEqual(notes(), before);
  // --all with --dry-run asks the model again and writes nothing.
  const logged = writes(f.log()).length;
  f.mantle({ labels: { 'agents/codex-alpha/deploys.md': 'personal' } });
  r = f.labelAgents('--all', '--dry-run', '--agent', 'codex-alpha');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.requests().length, 3);
  assert.match(r.stdout, /^label agents\/codex-alpha: dry-run, 1 label\(s\) to set or change$/m);
  assert.match(r.stdout, /^- agents\/codex-alpha\/deploys\.md: work → personal$/m);
  assert.equal(writes(f.log()).length, logged);
  assert.deepEqual(notes(), before);
});

test('label --agents without a notes clone needs both input files', (t) => {
  const f = agentLabelFixture(t);
  // As in a GitHub Actions job: no notes clone, and the label token in a file the job wrote.
  const tokenFile = join(f.tmp, 'label-token');
  writeFileSync(tokenFile, 'example-label-token-0001\n', { mode: 0o600 });
  const { credentials, ...rest } = LABEL_BLOCK;
  const block = { ...rest, tokenFile };
  f.writeConfig({ label: block, clone: false });
  const missing = (what) => `label: the label inputs are missing or invalid (${what}); no label was written.\n`;
  let r = f.labelAgents();
  assert.equal(r.status, 1);
  assert.equal(r.stdout, missing('label.domainsFile'));
  const domainsFile = join(f.tmp, 'domains.json');
  const personaFile = join(f.tmp, 'persona.md');
  writeFileSync(domainsFile, JSON.stringify(NO_EXCEPTIONS));
  writeFileSync(personaFile, PERSONA);
  f.writeConfig({ label: { ...block, domainsFile }, clone: false });
  r = f.labelAgents();
  assert.equal(r.status, 1);
  assert.equal(r.stdout, missing('label.personaFile'));
  // An organize --agents run fails the same way, after Organize.
  f.instruct({});
  r = f.organizeAgents();
  assert.equal(r.status, 1);
  assert.ok(r.stdout.endsWith(missing('label.personaFile')), r.stdout);
  assert.deepEqual(f.requests(), []);
  assert.deepEqual(writes(f.log()).filter((w) => w.key !== 'index/organizer.json'), []);
  // With both files named, the run labels the notes with the token of the file.
  f.writeConfig({ label: { ...block, domainsFile, personaFile }, clone: false });
  r = f.labelAgents();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.requests(), [{ paths: ['agents/codex-alpha/deploy-steps.md', 'agents/codex-alpha/deploys.md'], auth: true }]);
  assert.doesNotMatch(r.stdout + r.stderr, /example-label-token/);
  // The token's age counts from when the job wrote the file: 55 minutes later no batch starts.
  const issued = new Date(Date.now() - 55 * 60 * 1000);
  utimesSync(tokenFile, issued, issued);
  f.agentWrites('deploys', 'How deploys go now', 'Deploys now go through a canary first.');
  r = f.labelAgents();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^label: stopped; the label token of this run is near the end of its hour$/m);
  assert.equal(f.requests().length, 1);
  assert.match(r.stdout, /^- agents\/codex-alpha\/deploys\.md: not sent; the label token of this run was near the end of its hour$/m);
});

test('label --agents: usage errors, missing blocks and an unknown agent', (t) => {
  const f = agentLabelFixture(t);
  for (const args of [['--keep'], ['--model', 'other-label-model'], ['--project', 'p'], ['--min-retention', '0.5'], ['--agent', 'Bad_Name']]) {
    const r = f.labelAgents(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^usage: /m);
  }
  const unknown = f.labelAgents('--agent', 'nobody');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /"nobody" is not an agent scope of the bucket\./);
  const noAgents = agentLabelFixture(t, { block: null });
  let r = noAgents.labelAgents();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^agent-memory: labeling the agent scopes needs "agents" in the consolidate block of \S+; nothing was run\.$/m);
  const noLabel = agentLabelFixture(t, { label: null });
  r = noLabel.labelAgents();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^agent-memory: labeling needs "label" in the consolidate block of \S+; nothing was run\.$/m);
  // organize --agents without a label block ends without a label pass.
  noLabel.instruct({});
  r = noLabel.organizeAgents();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /^label/m);
  assert.deepEqual([...f.requests(), ...noAgents.requests(), ...noLabel.requests()], []);
});
