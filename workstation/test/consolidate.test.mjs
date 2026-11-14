import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
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
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
const cwd = process.cwd();
const scope = basename(cwd) === 'notes' ? basename(dirname(cwd)) : basename(cwd);
const args = process.argv.slice(2);
const addDirs = args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []));
let digest = null;
for (const d of addDirs) { try { digest = readFileSync(join(d, 'digest.md'), 'utf8'); } catch {} }
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ scope, cwd, args, digest, pid: process.pid }) + '\\n');
const all = JSON.parse(readFileSync(process.env.FAKE_INSTRUCTIONS, 'utf8'));
const ins = all[scope] ?? all['*'] ?? {};
for (const [rel, text] of Object.entries(ins.writes ?? {})) {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), text);
}
for (const [path, text] of Object.entries(ins.liveWrites ?? {})) writeFileSync(path, text);
for (const argv of ins.git ?? []) execFileSync('git', argv, { stdio: 'ignore' });
for (const [rel, target] of Object.entries(ins.links ?? {})) {
  rmSync(join(cwd, rel), { recursive: true, force: true });
  symlinkSync(target, join(cwd, rel));
}
for (const [path, mode] of Object.entries(ins.chmod ?? {})) chmodSync(path.startsWith('/') ? path : join(cwd, path), mode);
if (ins.sleepMs) await new Promise((resolve) => setTimeout(resolve, ins.sleepMs));
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
  assert.match(text, /^- Model: test-model; turns: 4; cost: USD 0\.25; stopped: completed$/m);
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
    { kind: 'organize', at: undefined, outcome: 'applied', stopReason: 'completed', costUsd: 0.25 });
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
  assert.match(r.stdout, /^organize p: rejected, nothing applied \(2 rule violation\(s\)\), USD 0\.25, stopped: completed$/m);
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
  assert.equal(f.calls().length, 1);
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
  const days = (n) => new Date(Date.now() - n * DAY_MS).toISOString();
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
  const turn = (type, text, extra = {}) => ({
    type, timestamp: '2026-11-13T10:00:00Z',
    message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] }, ...extra,
  });
  session('-work-p', 'p', [turn('user', SESSION_PHRASE, { promptSource: 'typed' }), turn('assistant', 'Noted.')]);
  session('-work-h', 'h', [turn('user', 'run the batch', { promptSource: 'sdk' }), turn('assistant', 'Done.')]);
  f.addSession = (slug, project, text, ageMs) =>
    session(slug, project, [turn('user', text, { promptSource: 'typed' }), turn('assistant', 'Noted.')], ageMs);
  return f;
}

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
  assert.match(text, /^- Model: test-model; turns: 9; cost: USD 5\.01; stopped: error_max_budget_usd$/m);
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
  assert.deepEqual(f.calls().map((c) => c.scope), ['p', 'q']);
  p = f.readState().projects.p;
  assert.equal(p.lastExtract, undefined);
  assert.ok(f.readState().projects.q.lastExtractTried);
});

test('state without lastExtractTried loads as never tried; unknown keys survive', (t) => {
  const f = extractFixture(t);
  f.setConfig({ maxProjects: 1 });
  f.seed({ 'projects/q/MEMORY.md': index('y.md'), 'projects/q/y.md': note('y', 'Y', 'Another project.') });
  f.addSession('-work-q', 'q', 'a question in q', 3 * 3600 * 1000);
  const days = (n) => new Date(Date.now() - n * DAY_MS).toISOString();
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

test('the run stops starting scopes once its summed cost reaches maxProjects × maxBudgetUsd', (t) => {
  const f = fixture(t, { consolidate: { maxProjects: 1, maxBudgetUsd: 1 } });
  f.seed({
    'projects/p1/a.md': note('a', 'A', 'One.'),
    'projects/p2/a.md': note('a', 'A', 'Two.'),
    'projects/p3/a.md': note('a', 'A', 'Three.'),
  });
  f.instruct({ '*': { result: { total_cost_usd: 0.6 } } });
  const r = f.run('organize', '--project', 'p1', '--project', 'p2', '--project', 'p3');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls().map((c) => c.scope), ['p1', 'p2']);
  assert.match(r.stdout, /ceiling/);
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

test('a model-chosen name of a non-note file is not printed', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.instruct({ p: { writes: { [`notes/${SESSION_PHRASE}.txt`]: 'x', [`notes/${SESSION_PHRASE}-2.txt`]: 'y' } } });
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: rejected, nothing applied \(1 rule violation\(s\)\)/m);
  assert.match(r.stdout, /^ {2}- notes\/\(2 entries that are not note files\): not a regular note file$/m);
  assert.doesNotMatch(r.stdout + r.stderr, /UNIQUE-SESSION-PHRASE/);
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

// Makes the n-th `git fetch` of the run slow: it touches `<tmp>/in-step`, then sleeps 3 s. Every
// fetch is counted in `<tmp>/fetches`. Each sync fetches once: the snapshot step's sync is the
// first fetch of a scope, the sync before applying the second, the sync after applying the third.
// The slow fetch also writes the pid of the step that runs it to `<tmp>/step.pid`, and touches
// `<tmp>/slept` when its sleep is over; when that step is gone by then, it exits without
// fetching.
function slowFetch(f, n) {
  const count = join(f.tmp, 'fetches');
  const marker = join(f.tmp, 'in-step');
  const pidFile = join(f.tmp, 'step.pid');
  const slept = join(f.tmp, 'slept');
  wrapGit(f, `for a in "$@"; do if [[ "$a" == fetch ]]; then k=$(cat "${count}" 2>/dev/null || echo 0); k=$((k+1)); echo $k > "${count}"; if [[ $k == ${n} ]]; then echo $PPID > "${pidFile}"; touch "${marker}"; sleep 3; touch "${slept}"; kill -0 $PPID 2>/dev/null || exit 1; fi; fi; done`);
  return {
    marker,
    slept,
    stepPid: () => Number(readFileSync(pidFile, 'utf8').trim()),
    fetches: () => Number(readFileSync(count, 'utf8').trim()),
  };
}

// Starts `run.sh consolidate <args>` and, once `marker` exists (a locked step is then running),
// sends `signal` to the driver alone, or with `group` to its whole process group as a terminal
// does (the step dies too). Returns the exit status and stdout.
async function signalDuringStep(t, f, signal, marker, args, { group = false } = {}) {
  const child = spawn(RUN_SH, ['consolidate', ...args], { env: f.env, stdio: ['ignore', 'pipe', 'ignore'], detached: group });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const exited = new Promise((resolve) => child.once('close', (code, sig) => resolve({ code, signal: sig })));
  t.after(() => {
    try { process.kill(group ? -child.pid : child.pid, 'SIGKILL'); } catch { /* already gone */ }
  });
  assert.ok(await waitFor(() => existsSync(marker)), 'the step started');
  process.kill(group ? -child.pid : child.pid, signal);
  return { status: await exited, stdout };
}

test('a signal during a locked step ends the run as aborted; the model is never started', async (t) => {
  for (const [signal, code, group] of [['SIGINT', 130, true], ['SIGINT', 130, false], ['SIGTERM', 143, false]]) {
    const f = fixture(t);
    duplicateProject(f);
    f.instruct(mergeInstruction());
    const { marker } = slowFetch(f, 1);
    const head = f.head();
    const { status, stdout } = await signalDuringStep(t, f, signal, marker, ['organize'], { group });
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
    const { marker } = slowFetch(f, 3);
    const { status, stdout } = await signalDuringStep(t, f, signal, marker, ['organize'], { group: true });
    assert.deepEqual(status, { code, signal: null }, signal);
    assert.match(stdout, /^organize p: applied, 3 change\(s\), USD 0\.25, stopped: completed$/m, signal);
    assert.match(stdout, /push pending/, signal);
    assert.doesNotMatch(stdout, /nothing applied/, signal);
    assert.doesNotMatch(stdout, /organize q:/, signal);
    assert.match(f.subjects()[0], /^consolidate\(alpha\): organize projects\/p/, signal);
    assert.equal(existsSync(join(f.repo, 'projects/p/b.md')), false, signal);
    const p = f.readState().projects.p;
    assert.equal(p.lastOutcome.outcome, 'applied', signal);
    assert.equal(p.organizedDigest, folderDigest(join(f.repo, 'projects/p')), signal);
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
  t.after(() => child.kill('SIGKILL'));
  assert.ok(await waitFor(() => existsSync(step.marker)), 'the step started');
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
  const { marker } = slowFetch(f, 3);
  const { status, stdout } = await signalDuringStep(t, f, 'SIGTERM', marker, ['organize']);
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
  const { marker, fetches } = slowFetch(f, 2);
  const { status, stdout } = await signalDuringStep(t, f, 'SIGINT', marker, ['organize']);
  assert.deepEqual(status, { code: 130, signal: null });
  assert.match(stdout, /^organize p: no-change, 0 change\(s\)/m);
  assert.doesNotMatch(stdout, /organize q:/);
  assert.equal(fetches(), 2);
  assert.deepEqual(f.calls().map((c) => c.scope), ['p']);
});
