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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('an interrupted run removes its work folder, digest included', async (t) => {
  const f = extractFixture(t);
  f.instruct({ p: { sleepMs: 20000 } });
  const child = spawn(RUN_SH, ['consolidate', 'extract'], { env: f.env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let call;
  try {
    for (let i = 0; i < 300 && !(call = f.calls()[0]); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(call, 'the model was called');
    assert.ok(existsSync(join(dirname(call.cwd), 'input/digest.md')));
    child.kill('SIGTERM');
    assert.deepEqual(await exited, { code: 143, signal: null });
    assert.deepEqual(readdirSync(f.workRoot()), []);
  } finally {
    child.kill('SIGKILL');
    if (call) {
      try { process.kill(-call.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
});

test('a rejected result changes nothing in the clone and keeps the organize state', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  f.instruct({ p: { writes: { 'notes/b.md': 'MOVED TO [[nothere]]\n', 'notes/MEMORY.md': index('a.md') } } });
  const head = f.head();
  const before = treeText(f.repo);
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: rejected/m);
  assert.match(r.stdout, /^ {2}- notes\/b\.md: the target note does not exist$/m);
  assert.equal(f.head(), head);
  assert.equal(treeText(f.repo), before);
  assert.deepEqual(f.reports(), []);
  const entry = f.readState().projects.p;
  assert.equal(entry.lastOrganize, undefined);
  assert.equal(entry.organizedDigest, undefined);
  assert.equal(entry.lastOutcome.outcome, 'rejected');
  assert.deepEqual(readdirSync(f.workRoot()), []);
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
  assert.match(r.stdout, /^organize p: changed-meanwhile/m);
  assert.match(r.stdout, /notes\/new\.md/);
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
      big: { lastOrganize: recent, organizedDigest: folderDigest(join(f.repo, 'projects/big')) },
      conflicted: { lastOrganize: old, organizedDigest: folderDigest(join(f.repo, 'projects/conflicted')) },
    },
  }));
  let r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls().map((c) => c.scope), ['big']);
  assert.match(r.stdout, /^organize big: no-change, 0 change\(s\)/m);

  f.setConfig({ maxProjects: 5 });
  r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls().map((c) => c.scope), ['big', 'big', 'conflicted', 'changed']);
  assert.doesNotMatch(r.stdout, /organize same|organize empty|organize global/);
  // A no-change run records the scope as organized.
  assert.equal(f.readState().projects.changed.organizedDigest, folderDigest(join(f.repo, 'projects/changed')));
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
  const session = (slug, project, records) => {
    const dir = join(f.claudeDir, 'projects', slug);
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(f.repo, 'projects', project), join(dir, 'memory'));
    const file = join(dir, `${slug}-session.jsonl`);
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const hourAgo = new Date(Date.now() - 3600 * 1000);
    utimesSync(file, hourAgo, hourAgo);
  };
  const turn = (type, text, extra = {}) => ({
    type, timestamp: '2026-11-13T10:00:00Z',
    message: { role: type, content: type === 'user' ? text : [{ type: 'text', text }] }, ...extra,
  });
  session('-work-p', 'p', [turn('user', SESSION_PHRASE, { promptSource: 'typed' }), turn('assistant', 'Noted.')]);
  session('-work-h', 'h', [turn('user', 'run the batch', { promptSource: 'sdk' }), turn('assistant', 'Done.')]);
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
  assert.match(r.stdout, /^organize p: no-change, 0 change\(s\)/m);
  assert.equal(f.head(), head);
  assert.deepEqual(f.reports(), []);
  assert.equal(f.readState().projects.p.organizedDigest, folderDigest(join(f.repo, 'projects/p')));
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
  // A model that did not run and changed nothing does not count as organized.
  f.instruct({ p: { silent: true } });
  write(f.repo, 'projects/p/c.md', note('c', 'C', 'Another.'));
  write(f.repo, 'projects/p/MEMORY.md', index('a.md', 'c.md'));
  f.sync();
  const digest = f.readState().projects.p.organizedDigest;
  const again = f.run('organize');
  assert.match(again.stdout, /^organize p: no-change, 0 change\(s\), USD unknown, stopped: no-result$/m);
  assert.equal(f.readState().projects.p.organizedDigest, digest);
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
  assert.match(r.stdout, /^organize p: rejected/m);
  assert.match(r.stdout, /distinct terms/);
  r = f.run('organize', '--min-retention', '0');
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

test('a failed sync before the snapshot skips the scope without calling the model', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  sh(f.repo, 'git', ['remote', 'set-url', 'origin', join(f.tmp, 'no-such-remote.git')]);
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: sync-failed/m);
  assert.deepEqual(f.calls(), []);
  assert.equal(f.readState().projects.p.lastOutcome.outcome, 'sync-failed');
});

test('a failed sync after an applied change still counts as applied; the push is pending', (t) => {
  const f = fixture(t);
  duplicateProject(f);
  const instruction = mergeInstruction();
  instruction.p.git = [['-C', f.repo, 'remote', 'set-url', 'origin', join(f.tmp, 'no-such-remote.git')]];
  f.instruct(instruction);
  const r = f.run('organize');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^organize p: applied/m);
  assert.match(r.stdout, /push pending/);
  assert.match(f.subjects()[0], /^consolidate\(alpha\): organize projects\/p/);
  assert.ok(f.remoteFiles().includes('projects/p/b.md'));
});
