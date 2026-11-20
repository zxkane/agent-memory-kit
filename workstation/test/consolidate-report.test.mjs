import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport } from '../lib/reports.mjs';
import { isolatedEnv, isolateGit, sh, tempDir } from './helpers.mjs';

isolateGit();

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_SH = join(PKG, 'run.sh');
const DAY_MS = 24 * 3600 * 1000;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const day = (daysAgo) => new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
const at = (daysAgo) => new Date(Date.now() - daysAgo * DAY_MS).toISOString();
const note = (name, label = null) =>
  `---\nname: ${name}\ndescription: About ${name}\nmetadata:\n  type: project\n${label ? `  domain: ${label}\n` : ''}---\n\n${name} body.\n`;
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

// The digest Organize records: SHA-256 over the sorted `name:hash` lines of the note files.
function folderDigest(dir) {
  return sha(readdirSync(dir).filter((n) => n.endsWith('.md')).sort().map((n) => `${n}:${sha(readFileSync(join(dir, n)))}`).join('\n'));
}

// Every file under dir (the .git folder excluded) with its content and modification time.
function snapshotOf(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p] = `${statSync(p).mtimeMs} ${readFileSync(p, 'utf8')}`;
    }
  };
  walk(dir);
  return out;
}

// A JSON report as the kit writes it.
const extractJson = (host, date, scope, extra = {}) => ({
  schemaVersion: 1, host, kind: 'extract', scope, date, model: 'example-model', stopReason: 'completed', costUsd: 0.25, turns: 4,
  denials: 0, repaired: 0, conversation: { truncated: false, bytes: 900, sessionsLeftOut: 0 }, folders: [],
  retention: { termsKept: 1, termsBefore: 1, share: 1 }, counts: { added: 1, changed: 1, retired: 0, notApplied: 0 },
  changes: [{ kind: 'add', path: 'n.md' }, { kind: 'change', path: 'MEMORY.md' }], ...extra,
});

// A clone, a state folder and a configuration as a consolidation machine has them, with reports
// of two machines, a run log and the record of Organize and of the label step.
function reportFixture(t, { organize = 'Sun *-*-* 04:30' } = {}) {
  const tmp = tempDir(t);
  const home = join(tmp, 'home');
  const repo = join(tmp, 'notes');
  const state = join(tmp, 'state');
  mkdirSync(home);
  mkdirSync(state);
  sh(tmp, 'git', ['init', '-q', '-b', 'main', repo]);
  const big = Array.from({ length: 201 }, (_, i) => `- [n${i}](n${i}.md) — line ${i}`).join('\n') + '\n';
  const files = {
    'global/MEMORY.md': '- [g](g.md) — g\n', 'global/g.md': note('g', 'general'),
    'projects/example-project/a.md': note('a', 'work'), 'projects/example-project/b.md': note('b'),
    'projects/kept/c.md': note('c', 'personal'),
    'projects/big/MEMORY.md': big, 'projects/big/n0.md': note('n0', 'work'),
    'projects/empty/MEMORY.md': '',
    'projects/broken/d.md': '---\nname: d\ndescription: D\nmetadata: {}\n---\n\nInline metadata.\n',
  };
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  const digest = (rel) => folderDigest(join(repo, rel));
  const shaOf = (rel) => sha(readFileSync(join(repo, rel)));
  writeFileSync(join(state, 'consolidate.json'), JSON.stringify({
    projects: {
      global: { lastOrganize: at(3), organizedDigest: digest('global') },
      kept: { lastOrganize: at(3), organizedDigest: digest('projects/kept') },
      big: { lastOrganize: at(40), organizedDigest: digest('projects/big') },
      broken: { lastOrganize: at(2), organizedDigest: 'f'.repeat(64) },
    },
    labels: { version: 1, notes: { 'global/g.md': shaOf('global/g.md'), 'projects/example-project/a.md': '0'.repeat(64) } },
  }));
  const reports = {
    [`${day(1)}-alpha-extract-example-project.json`]: JSON.stringify(extractJson('alpha', day(1), 'example-project')),
    [`${day(1)}-alpha-extract-example-project.md`]: '# kept beside its twin, never read\n',
    [`${day(2)}-beta-extract-kept.json`]: JSON.stringify(extractJson('beta', day(2), 'kept', { costUsd: null })),
    [`${day(3)}-alpha-organize-big.md`]: buildReport({
      config: { host: 'alpha' }, kind: 'organize', scope: 'big', date: day(3), model: 'example-model', stopReason: 'completed',
      costUsd: 0.5, turns: 9, denials: 0, pairs: [{ label: 'notes' }], snap: { notes: { 'old.md': 'h' } },
      ev: {
        changes: [{ label: 'notes', file: 'old.md', kind: 'retire', target: { label: 'notes', file: 'n0.md' } }], ignored: [], ignoredEntries: {},
        stats: {
          notes: { indexBefore: { lines: 202, bytes: 9000 }, indexAfter: { lines: 201, bytes: 8950 }, unlistedBefore: 0, unlistedAfter: 0, notesBytesBefore: 300, notesBytesAfter: 200, retiredBytes: 100 },
          retention: { termsBefore: 4, termsKept: 4, share: 1 },
        },
      },
      descriptions: new Map(), conversation: null,
    }),
    [`${day(4)}-alpha-label.json`]: '{"schemaVersion": 1, "kind": "label", "host": "alpha", "date": "cut',
    [`${day(5)}-gamma-organize-x.json`]: JSON.stringify({ ...extractJson('gamma', day(5), 'x'), schemaVersion: 2 }),
    [`${day(5)}-alpha-extract-notes.md`]: '# A note someone filed here\n',
    [`${day(30)}-alpha-extract-example-project.json`]: JSON.stringify(extractJson('alpha', day(30), 'example-project')),
    'README.md': 'Reports of the consolidation runs.\n',
  };
  for (const [name, text] of Object.entries(reports)) write(repo, `_reports/${name}`, text);
  const run = (daysAgo, extra = {}) => JSON.stringify({
    schemaVersion: 1, runId: `run-${daysAgo}`, host: 'alpha', kind: 'organize', agents: false, dryRun: false, startedAt: at(daysAgo),
    endedAt: at(daysAgo), exitCode: 0, scopes: [{ scope: 'example-project', outcome: 'applied', stopReason: 'completed', costUsd: 0.25 }],
    costUsd: 0.25, ...extra,
  });
  writeFileSync(join(state, 'runs.jsonl'), [
    run(20), run(2), 'not json', run(1, { exitCode: 1, scopes: [], costUsd: 0, error: 'scan-failed' }),
    run(0.5, { kind: 'label', scopes: [], label: { outcome: 'applied', failed: false, stop: null, costUsd: 0.01, requests: 1, sent: 2, written: 2, unchanged: 0, notWritten: 0 }, costUsd: 0.01 }),
    '',
  ].join('\n'));
  const configFile = join(tmp, 'config.json');
  writeFileSync(configFile, JSON.stringify({
    enabled: true, host: 'alpha', repoDir: repo, stateDir: state, claudeDir: join(tmp, 'claude'),
    consolidate: { command: '/bin/true', model: 'example-model', maxProjects: 2, ...(organize ? { organize } : {}) },
  }));
  const env = isolatedEnv(home, { AGENT_MEMORY_CONFIG: configFile });
  return {
    tmp, home, repo, state, configFile, env,
    report: (...args) => spawnSync(RUN_SH, ['consolidate', 'report', ...args], { env, encoding: 'utf8' }),
    json(...args) {
      const r = this.report('--format', 'json', ...args);
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    },
  };
}

test('consolidate report gathers the reports of every machine, this machine\'s runs, the backlog and the labels', (t) => {
  const f = reportFixture(t);
  const before = Date.now();
  const report = f.json('--days', '7');
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.host, 'alpha');
  const [since, until, generated] = [Date.parse(report.window.since), Date.parse(report.window.until), Date.parse(report.generatedAt)];
  assert.ok(Math.abs(until - since - 7 * DAY_MS) < 1000 && generated >= before && until === generated, JSON.stringify(report.window));
  // Reports: the JSON twins, and a Markdown report without one, read back from its text.
  assert.deepEqual(report.reports.map((r) => [r.file, r.source, r.host, r.kind]), [
    [`_reports/${day(3)}-alpha-organize-big.md`, 'markdown', 'alpha', 'organize'],
    [`_reports/${day(2)}-beta-extract-kept.json`, 'json', 'beta', 'extract'],
    [`_reports/${day(1)}-alpha-extract-example-project.json`, 'json', 'alpha', 'extract'],
  ]);
  assert.deepEqual(report.reports[2], { file: `_reports/${day(1)}-alpha-extract-example-project.json`, source: 'json', ...extractJson('alpha', day(1), 'example-project') });
  assert.deepEqual([report.reports[0].counts, report.reports[0].costUsd, report.reports[0].changes], [
    { added: 0, changed: 0, retired: 1, notApplied: 0 }, 0.5, [{ kind: 'retire', path: 'old.md', target: 'n0.md' }],
  ]);
  // Runs: this machine's, of the window, in the order they ended.
  assert.deepEqual(report.runs.map((r) => r.runId), ['run-2', 'run-1', 'run-0.5']);
  assert.equal(report.runs[1].error, 'scan-failed');
  // The backlog, judged by Organize's own rule.
  assert.deepEqual(report.backlog.scopes.map((s) => [s.scope, s.notes, s.dueReason, s.neverOrganized, s.overLimits]), [
    ['global', 1, null, false, false],
    ['big', 1, 'over-limits', false, true],
    ['broken', 1, 'changed', false, false],
    ['empty', 0, null, true, false],
    ['example-project', 2, 'never-organized', true, false],
    ['kept', 1, null, false, false],
  ]);
  assert.deepEqual(report.backlog.scopes.map((s) => s.due), [false, true, true, false, true, false]);
  assert.equal(report.backlog.scopes[0].lastOrganize, JSON.parse(readFileSync(join(f.state, 'consolidate.json'), 'utf8')).projects.global.lastOrganize);
  assert.equal(report.backlog.scopes[4].lastOrganize, null);
  assert.deepEqual(report.backlog.totals, { scopes: 6, withNotes: 5, notes: 6, due: 3, neverOrganized: 1, overLimits: 1 });
  assert.deepEqual([report.backlog.maxProjects, report.backlog.etaWeeks], [2, 2]);
  // The labels of the notes, and what the next label run takes: notes without an entry or whose
  // entry is not their digest, never one Organize must repair first.
  assert.deepEqual(report.labels, {
    recorded: true, counts: { work: 2, personal: 1, general: 1, unlabeled: 2 },
    unlabeled: ['projects/broken/d.md', 'projects/example-project/b.md'], pending: 4, needsRepair: 1,
  });
  // What could not be read is named, never fatal.
  assert.deepEqual(report.problems, [
    { file: 'runs.jsonl', line: 3, problem: 'not valid JSON' },
    { file: `_reports/${day(5)}-alpha-extract-notes.md`, problem: 'not a report the kit wrote' },
    { file: `_reports/${day(5)}-gamma-organize-x.json`, problem: 'not a report of schemaVersion 1' },
    { file: `_reports/${day(4)}-alpha-label.json`, problem: 'not valid JSON' },
  ]);
});

test('the window: --since a day, --days n, and seven days without either', (t) => {
  const f = reportFixture(t);
  const since = f.json('--since', day(2));
  assert.equal(since.window.since, `${day(2)}T00:00:00.000Z`);
  assert.deepEqual(since.reports.map((r) => r.date), [day(2), day(1)]);
  assert.deepEqual(since.runs.map((r) => r.runId), ['run-2', 'run-1', 'run-0.5']);
  assert.deepEqual(f.json('--days', '1').runs.map((r) => r.runId), ['run-0.5']);
  assert.deepEqual(f.json('--days', '30').reports.map((r) => r.date).at(0), day(30));
  const plain = f.json();
  assert.ok(Math.abs(Date.parse(plain.window.until) - Date.parse(plain.window.since) - 7 * DAY_MS) < 1000);
  for (const bad of [['--days', '0'], ['--days', '366'], ['--days', 'x'], ['--days'], ['--since', '2026-02-30'], ['--since', '20261101'],
    ['--since', day(-2)], ['--since', day(1), '--days', '2'], ['--days', '2', '--days', '3'], ['--format', 'xml'], ['--format'], ['extra']]) {
    const r = f.report(...bad);
    assert.equal(r.status, 2, bad.join(' '));
    assert.equal(r.stdout, '', bad.join(' '));
    assert.match(r.stderr, /^usage: run\.sh consolidate report \[--since <YYYY-MM-DD> \| --days <n>\] \[--format json\|md\]$/m, bad.join(' '));
  }
});

test('--format md gives a short summary of the same report', (t) => {
  const f = reportFixture(t);
  const r = f.report('--since', day(6));
  assert.equal(r.status, 0, r.stderr);
  const text = r.stdout;
  assert.match(text, new RegExp(`^Consolidation on alpha, ${day(6)} 00:00 to \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC$`, 'm'));
  assert.match(text, /^Runs on this machine: 3, 1 failed$/m);
  assert.match(text, /^- \S+ \S+ organize: exit 1, error scan-failed, USD 0\.00$/m);
  assert.match(text, /^- \S+ \S+ label: exit 0, label applied, 2 written, USD 0\.01$/m);
  assert.match(text, /^- \S+ \S+ organize: exit 0, 1 scope\(s\) \(example-project applied\), USD 0\.25$/m);
  assert.match(text, /^Reports: 3 \(alpha 2, beta 1\)$/m);
  assert.match(text, new RegExp(`^- ${day(3)} alpha organize big: 0 added, 0 changed, 1 retired, USD 0\\.50 \\(from the Markdown\\)$`, 'm'));
  assert.match(text, new RegExp(`^- ${day(2)} beta extract kept: 1 added, 1 changed, 0 retired, USD unknown$`, 'm'));
  assert.match(text, /^Organize backlog: 3 of 5 scope\(s\) with notes due \(1 never organized, 1 over the index limits\); about 2 week\(s\) at 2 a run$/m);
  assert.match(text, /^Labels: 2 work, 1 personal, 1 general, 2 unlabeled; 4 note\(s\) for the next label run$/m);
  assert.match(text, /^Problems: 4$/m);
  assert.match(text, /^- runs\.jsonl line 3: not valid JSON$/m);
  assert.match(text, new RegExp(`^- _reports/${day(4)}-alpha-label\\.json: not valid JSON$`, 'm'));
  // Without an Organize schedule there is no estimate.
  const g = reportFixture(t, { organize: null });
  assert.doesNotMatch(g.report().stdout, /week/);
  assert.equal(g.json().backlog.etaWeeks, null);
});

test('consolidate report writes nothing, takes no lock and runs while a consolidation holds its lock', async (t) => {
  const f = reportFixture(t);
  const lockDir = join(f.home, '.local/state/agent-memory');
  mkdirSync(lockDir, { recursive: true });
  const holder = spawn('bash', ['-c', 'exec 8> "$1"; exec 9> "$2"; flock 8; flock 9; echo held; sleep 30', 'holder',
    join(lockDir, 'consolidate.lock'), join(lockDir, 'sync.lock')], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const before = [snapshotOf(f.repo), snapshotOf(f.state), readdirSync(lockDir).sort()];
  const head = sh(f.repo, 'git', ['status', '--porcelain']);
  const r = f.report('--format', 'json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).host, 'alpha');
  assert.equal(f.report().status, 0);
  assert.deepEqual([snapshotOf(f.repo), snapshotOf(f.state), readdirSync(lockDir).sort()], before);
  assert.equal(sh(f.repo, 'git', ['status', '--porcelain']), head);
});

test('a missing clone, state or configuration', (t) => {
  const f = reportFixture(t);
  const config = JSON.parse(readFileSync(f.configFile, 'utf8'));
  writeFileSync(f.configFile, JSON.stringify({ ...config, repoDir: join(f.tmp, 'nowhere'), stateDir: join(f.tmp, 'no-state') }));
  const report = f.json();
  assert.deepEqual([report.reports, report.runs, report.backlog.scopes, report.labels.counts], [[], [], [], { work: 0, personal: 0, general: 0, unlabeled: 0 }]);
  assert.deepEqual(report.problems, [{ file: null, problem: 'the notes clone does not exist' }]);
  // An invalid consolidate block, and a state file that is not JSON.
  writeFileSync(f.configFile, JSON.stringify({ ...config, consolidate: { ...config.consolidate, maxTurns: 2000 } }));
  writeFileSync(join(f.state, 'consolidate.json'), 'not json');
  const odd = f.json();
  assert.deepEqual(odd.problems.filter((p) => p.file === null || p.file === 'consolidate.json'), [
    { file: null, problem: 'the consolidate block is invalid (maxTurns)' },
    { file: 'consolidate.json', problem: 'not valid JSON' },
  ]);
  assert.equal(odd.backlog.etaWeeks, null);
  assert.equal(readFileSync(join(f.state, 'consolidate.json'), 'utf8'), 'not json', 'never moved aside');
  assert.equal(odd.labels.recorded, false);
  writeFileSync(f.configFile, 'not json');
  const r = f.report();
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^agent-memory is not enabled on this machine\.$/m);
});

test('consolidate report loads no AWS code, no label client and no model client', (t) => {
  const f = reportFixture(t);
  const dir = tempDir(t);
  const hook = join(dir, 'record-loads.mjs');
  writeFileSync(hook, [
    "import { appendFileSync } from 'node:fs';",
    "import { registerHooks } from 'node:module';",
    'registerHooks({ load(url, context, next) { appendFileSync(process.env.AM_LOAD_LOG, `${url}\\n`); return next(url, context); } });',
    '',
  ].join('\n'));
  const log = join(dir, 'loads.log');
  const r = spawnSync(process.execPath, ['--import', hook, join(PKG, 'consolidate-report.mjs'), '--format', 'json'], {
    env: { ...f.env, AM_LOAD_LOG: log }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const loads = readFileSync(log, 'utf8');
  assert.match(loads, /lib\/run-report\.mjs/);
  assert.match(loads, /lib\/scopes\.mjs/);
  assert.doesNotMatch(loads, /lib\/(aws|s3|label-client|agent-scopes|agent-labels|model-run|sync-engine)\.mjs|\/node_modules\//);
});

test('the summary shows a figure it cannot use as ? and no control character; a file name that looks like a credential is withheld', (t) => {
  const f = reportFixture(t);
  const key = ['AKIA', 'Q3JZ7XK2M4N8P6R1'].join('');
  const odd = { schemaVersion: 1, endedAt: new Date().toISOString(), kind: 'organize\u001b[31m', exitCode: 'x', costUsd: '1', scopes: 'none', label: { outcome: 'applied', written: '2' } };
  writeFileSync(join(f.state, 'runs.jsonl'), `${JSON.stringify(odd)}\n`);
  write(f.repo, `_reports/${day(1)}-alpha-organize-odd.json`, JSON.stringify({ schemaVersion: 1, kind: 'organize', host: 'alpha\u0007', date: day(1), scope: 'odd', counts: null, costUsd: 'free' }));
  write(f.repo, `_reports/${day(1)}-alpha-extract-${key}.json`, 'not json');
  const r = f.report();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /[\u0000-\u0008\u000b-\u001f\u007f]/);
  assert.match(r.stdout, /organize\?\[31m: exit \?, label applied, \? written, USD unknown$/m);
  assert.match(r.stdout, new RegExp(`^- ${day(1)} alpha\\? organize odd: \\? added, \\? changed, \\? retired, USD unknown$`, 'm'));
  const json = f.json();
  assert.ok(json.problems.some((p) => p.file === '_reports/(file name withheld)' && p.problem === 'not valid JSON'), JSON.stringify(json.problems));
  assert.doesNotMatch(r.stdout + JSON.stringify(json), new RegExp(key));
});
