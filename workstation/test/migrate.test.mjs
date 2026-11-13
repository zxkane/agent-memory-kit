import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigration, buildRootMap, planMigration } from '../lib/migrate.mjs';
import { sanitizeSlug } from '../lib/project.mjs';
import { isolatedEnv, isolateGit, makeRemoteAndClones, sh, tempDir } from './helpers.mjs';

isolateGit();

const RUN = join(dirname(fileURLToPath(import.meta.url)), '..', 'run.sh');
const token = () => `${'gh'}${'p_'}${'a'.repeat(36)}`;
const slugOf = sanitizeSlug;
const read = (...parts) => readFileSync(join(...parts), 'utf8');
const put = (dir, name, text) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
};

function makeRepo(path, origin) {
  mkdirSync(path, { recursive: true });
  sh(path, 'git', ['init', '-q', '-b', 'main']);
  if (origin) sh(path, 'git', ['remote', 'add', 'origin', origin]);
  return path;
}

function session(claudeDir, slug, cwd) {
  const dir = join(claudeDir, 'projects', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 's.jsonl'), `${JSON.stringify({ type: 'summary' })}\n${JSON.stringify({ cwd })}\n`);
  return dir;
}

function tree(dir) {
  if (!existsSync(dir)) return null;
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      out.push(p);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

const USER_NOTE = '---\nname: prefs\nmetadata:\n  type: user\n---\nPrefers short answers.\n';
const PROJECT_NOTE = '---\nname: layout\nmetadata:\n  type: project\n---\nThe layout.\n';

// A claude directory with a repository that has notes, an empty one, and a folder with no repository.
// With `clone`, the notes directory is a real clone of a bare remote.
function fixture(t, { clone = false } = {}) {
  const base = tempDir(t);
  const claudeDir = join(base, 'claude');
  let repoDir = join(base, 'clone');
  let remote = null;
  if (clone) ({ a: repoDir, remote } = makeRemoteAndClones(t));
  else mkdirSync(repoDir, { recursive: true });
  const repoA = makeRepo(join(base, 'work', 'example-repo'), 'git@example.com:owner/example-repo.git');
  const emptyRepo = makeRepo(join(base, 'work', 'fixture-empty'), 'git@example.com:owner/fixture-empty.git');
  const memA = join(session(claudeDir, slugOf(repoA), repoA), 'memory');
  put(memA, 'MEMORY.md', '- [Layout](layout.md) - the layout\n- [Prefs](prefs.md) - preferences\n- [Leak](leak.md) - oops\n');
  put(memA, 'layout.md', PROJECT_NOTE);
  put(memA, 'prefs.md', USER_NOTE);
  put(memA, 'leak.md', `1\n2\n3\n4\n5\n6\nkey ${token()}\n`);
  const memE = join(session(claudeDir, slugOf(emptyRepo), emptyRepo), 'memory');
  mkdirSync(memE, { recursive: true });
  const memT = join(claudeDir, 'projects', '-zz-no-repository', 'memory');
  put(memT, 'note.md', 'x');
  const config = {
    host: 'alpha', repoDir, repoUrl: null, stateDir: join(base, 'state'), claudeDir, staleAfterSeconds: 600,
  };
  return { base, config, remote, repoA, emptyRepo, memA, memE, memT };
}

test('buildRootMap maps a worktree session to the main repository root', (t) => {
  const base = tempDir(t);
  const claudeDir = join(base, 'claude');
  const main = makeRepo(join(base, 'work', 'example-repo'), null);
  sh(main, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const wt = join(base, 'work', 'example-repo-wt');
  sh(main, 'git', ['worktree', 'add', '-q', '-b', 'topic', wt]);
  session(claudeDir, slugOf(wt), wt);
  const map = buildRootMap(claudeDir);
  assert.equal(map.get(slugOf(main)), main);
  assert.equal(map.has(slugOf(wt)), false);
});

test('buildRootMap skips missing, unreadable and unusable data', (t) => {
  const base = tempDir(t);
  const claudeDir = join(base, 'claude');
  assert.equal(buildRootMap(claudeDir).size, 0);
  mkdirSync(join(claudeDir, 'projects', '-empty'), { recursive: true });
  put(join(claudeDir, 'projects', '-garbage'), 's.jsonl', 'not json\n{"cwd": 5}\n{"cwd": "/nonexistent/path"}\n');
  assert.equal(buildRootMap(claudeDir).size, 0);
});

test('buildRootMap reads only the newest session file of a folder', (t) => {
  const base = tempDir(t);
  const claudeDir = join(base, 'claude');
  const current = makeRepo(join(base, 'work', 'example-repo'), null);
  const former = makeRepo(join(base, 'work', 'other-repo'), null);
  const dir = session(claudeDir, slugOf(current), current);
  writeFileSync(join(dir, 'old.jsonl'), `${JSON.stringify({ cwd: former })}\n`);
  const old = new Date('2020-01-01T00:00:00Z');
  utimesSync(join(dir, 'old.jsonl'), old, old);
  const map = buildRootMap(claudeDir);
  assert.equal(map.get(slugOf(current)), current);
  assert.equal(map.has(slugOf(former)), false);
});

test('buildRootMap drops a folder name claimed by two different roots', (t) => {
  const base = tempDir(t);
  const claudeDir = join(base, 'claude');
  const one = makeRepo(join(base, 'a-b', 'c'), null);
  const two = makeRepo(join(base, 'a', 'b-c'), null);
  assert.equal(slugOf(one), slugOf(two));
  session(claudeDir, '-one', one);
  session(claudeDir, '-two', two);
  assert.equal(buildRootMap(claudeDir).has(slugOf(one)), false);
});

test('planMigration classifies folders', (t) => {
  const { config, repoA, emptyRepo } = fixture(t);
  const items = planMigration(config);
  assert.deepEqual(items.map((i) => [i.slug, i.action, i.reason]), [
    [slugOf(repoA), 'adopt', null],
    [slugOf(emptyRepo), 'skip', 'empty'],
    ['-zz-no-repository', 'skip', 'no-repository'],
  ]);
  const a = items[0];
  assert.equal(a.project, 'example-repo');
  assert.equal(a.root, repoA);
  assert.equal(a.files, 4);
  assert.equal(items[2].root, null);
});

test('planMigration reports findings without the secret text', (t) => {
  const { config, repoA } = fixture(t);
  const item = planMigration(config).find((i) => i.slug === slugOf(repoA));
  assert.deepEqual(item.findings, [{ file: 'leak.md', id: 'github-token', line: 7 }]);
  assert.equal(JSON.stringify(item).includes(token()), false);
});

test('planMigration refuses a repository whose name is not a safe project name', (t) => {
  const { config, base } = fixture(t);
  const odd = makeRepo(join(base, 'work', 'odd name'), null);
  put(join(session(config.claudeDir, slugOf(odd), odd), 'memory'), 'n.md', 'x');
  const item = planMigration(config).find((i) => i.slug === slugOf(odd));
  assert.deepEqual([item.action, item.reason, item.project], ['skip', 'unsafe-project-name', null]);
});

test('planMigration reports a memory folder holding a subfolder as nested-entries, never as empty', (t) => {
  const { config, base } = fixture(t);
  const withNote = makeRepo(join(base, 'work', 'nested-repo'), 'git@example.com:owner/nested-repo.git');
  const onlySub = makeRepo(join(base, 'work', 'only-sub'), 'git@example.com:owner/only-sub.git');
  const memNested = join(session(config.claudeDir, slugOf(withNote), withNote), 'memory');
  put(memNested, 'note.md', 'x');
  put(join(memNested, 'sub'), 'deep.md', 'd');
  mkdirSync(join(session(config.claudeDir, slugOf(onlySub), onlySub), 'memory', 'sub'), { recursive: true });
  const items = planMigration(config);
  for (const slug of [slugOf(withNote), slugOf(onlySub)]) {
    const item = items.find((i) => i.slug === slug);
    assert.deepEqual([item.action, item.reason], ['skip', 'nested-entries'], slug);
  }
  const r = applyMigration(items, config, { skipFlagged: true });
  assert.deepEqual(r.skipped.filter((x) => x.reason === 'nested-entries').map((x) => x.slug).sort(), [slugOf(onlySub), slugOf(withNote)].sort());
  assert.ok(lstatSync(memNested).isDirectory());
  assert.equal(existsSync(join(config.repoDir, 'projects', 'nested-repo')), false);
});

test('planMigration writes nothing', (t) => {
  const { config, base } = fixture(t);
  const before = tree(base);
  planMigration(config);
  planMigration(config);
  assert.deepEqual(tree(base), before);
  assert.equal(existsSync(join(config.repoDir, 'projects')), false);
});

test('planMigration ignores a memory folder that is already a symlink', (t) => {
  const { config, base, repoA } = fixture(t);
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(elsewhere);
  const other = makeRepo(join(base, 'work', 'other-repo'), null);
  const dir = session(config.claudeDir, slugOf(other), other);
  symlinkSync(elsewhere, join(dir, 'memory'));
  const slugs = planMigration(config).map((i) => i.slug);
  assert.equal(slugs.includes(slugOf(other)), false);
  assert.equal(slugs.includes(slugOf(repoA)), true);
});

test('applyMigration refuses flagged files unless told to skip them', (t) => {
  const { config, memA } = fixture(t);
  const items = planMigration(config);
  assert.throws(() => applyMigration(items, config), /flagged files present/);
  assert.ok(lstatSync(memA).isDirectory());
  const r = applyMigration(items, config, { skipFlagged: true, now: new Date('2026-11-13T07:00:00Z') });
  assert.equal(existsSync(join(config.repoDir, 'projects', 'example-repo', 'leak.md')), false);
  assert.equal(r.adopted, 1);
  assert.ok(lstatSync(memA).isSymbolicLink());
  assert.equal(realpathSync(memA), realpathSync(join(config.repoDir, 'projects', 'example-repo')));
  const backup = readdirSync(dirname(memA)).find((n) => n.startsWith('memory.local-backup-'));
  assert.equal(read(dirname(memA), backup, 'leak.md').includes(token()), true);
  assert.equal(readFileSync(join(config.repoDir, 'projects', 'example-repo', '.project'), 'utf8'), 'example.com/owner/example-repo\n');
  assert.deepEqual(r.skipped.map((x) => x.reason), ['empty', 'no-repository']);
  assert.deepEqual(r.adoptedFolders, [{
    slug: slugOf(items[0].root), project: 'example-repo', backupDir: join(dirname(memA), backup), leftOut: ['leak.md'],
  }]);
});

test('applyMigration moves user-type notes and their index lines to global', (t) => {
  const { config } = fixture(t);
  const r = applyMigration(planMigration(config), config, { skipFlagged: true });
  assert.deepEqual(r.movedToGlobal, ['prefs.md']);
  const project = join(config.repoDir, 'projects', 'example-repo');
  assert.match(read(config.repoDir, 'global/MEMORY.md'), /\]\(prefs\.md\)/);
  assert.equal(read(config.repoDir, 'global/prefs.md'), USER_NOTE);
  assert.equal(existsSync(join(project, 'prefs.md')), false);
  assert.doesNotMatch(read(project, 'MEMORY.md'), /\]\(prefs\.md\)/);
  assert.match(read(project, 'MEMORY.md'), /\]\(layout\.md\)/);
  assert.equal(read(project, 'layout.md'), PROJECT_NOTE);
});

test('a user-type note that collides in global keeps both versions', (t) => {
  const { config } = fixture(t);
  put(join(config.repoDir, 'global'), 'prefs.md', 'other machine');
  put(join(config.repoDir, 'global'), 'MEMORY.md', '- [Old](prefs.md) - existing\n');
  const r = applyMigration(planMigration(config), config, { skipFlagged: true });
  assert.deepEqual(r.movedToGlobal, ['prefs.alpha.md']);
  assert.equal(read(config.repoDir, 'global/prefs.md'), 'other machine');
  assert.equal(read(config.repoDir, 'global/prefs.alpha.md'), USER_NOTE);
  assert.match(read(config.repoDir, 'global/MEMORY.md'), /\]\(prefs\.alpha\.md\)/);
});

test('a second apply is a no-op', (t) => {
  const { config } = fixture(t);
  applyMigration(planMigration(config), config, { skipFlagged: true });
  const again = planMigration(config);
  assert.deepEqual(again.map((i) => i.action), ['skip', 'skip']);
  const r = applyMigration(again, config);
  assert.equal(r.adopted, 0);
  assert.equal(r.copied, 0);
  assert.deepEqual(r.movedToGlobal, []);
});

test('handles folder names that begin with a dash', (t) => {
  const { config, memA, repoA } = fixture(t);
  assert.ok(slugOf(repoA).startsWith('-'));
  applyMigration(planMigration(config), config, { skipFlagged: true });
  assert.ok(lstatSync(memA).isSymbolicLink());
  assert.equal(read(memA, 'layout.md'), PROJECT_NOTE);
});

test('a flagged MEMORY.md is not copied and is reported', (t) => {
  const { config, memA } = fixture(t);
  writeFileSync(join(memA, 'MEMORY.md'), `- [Layout](layout.md) - key ${token()}\n`);
  const items = planMigration(config);
  assert.deepEqual(items[0].findings.map((f) => f.file).sort(), ['MEMORY.md', 'leak.md']);
  const r = applyMigration(items, config, { skipFlagged: true });
  assert.equal(existsSync(join(config.repoDir, 'projects', 'example-repo', 'MEMORY.md')), false);
  assert.deepEqual(r.indexNotCopied, [slugOf(items[0].root)]);
  assert.equal(JSON.stringify(r).includes(token()), false);
});

test('a project folder bound to another repository makes the folder a name collision', (t) => {
  const { config, memA } = fixture(t);
  put(join(config.repoDir, 'projects', 'example-repo'), '.project', 'example.com/someone/example-repo\n');
  const before = tree(config.repoDir);
  const items = planMigration(config);
  assert.deepEqual([items[0].action, items[0].reason], ['skip', 'name-collision']);
  assert.deepEqual(tree(config.repoDir), before);
  assert.ok(lstatSync(memA).isDirectory());
});

test('apply skips a folder whose project became bound to another repository after planning', (t) => {
  const { config, memA } = fixture(t);
  const items = planMigration(config);
  put(join(config.repoDir, 'projects', 'example-repo'), '.project', 'example.com/someone/example-repo\n');
  const r = applyMigration(items, config, { skipFlagged: true });
  assert.equal(r.adopted, 0);
  assert.deepEqual(r.skipped.find((s) => s.slug === items[0].slug), { slug: items[0].slug, reason: 'name-collision' });
  assert.ok(lstatSync(memA).isDirectory());
  assert.equal(readdirSync(join(config.repoDir, 'projects', 'example-repo')).includes('layout.md'), false);
});

test('two folders with one project name and different identities: the first is adopted, the second skipped', (t) => {
  const base = tempDir(t);
  const claudeDir = join(base, 'claude');
  const repoDir = join(base, 'clone');
  mkdirSync(repoDir);
  const first = makeRepo(join(base, 'a', 'example-repo'), 'git@example.com:owner/example-repo.git');
  const second = makeRepo(join(base, 'b', 'example-repo'), 'git@example.com:fork/example-repo.git');
  const memFirst = join(session(claudeDir, slugOf(first), first), 'memory');
  const memSecond = join(session(claudeDir, slugOf(second), second), 'memory');
  put(memFirst, 'one.md', '1');
  put(memSecond, 'two.md', '2');
  const config = { host: 'alpha', repoDir, repoUrl: null, stateDir: join(base, 's'), claudeDir, staleAfterSeconds: 600 };
  const items = planMigration(config);
  assert.deepEqual(items.map((i) => [i.slug, i.action, i.reason]), [
    [slugOf(first), 'adopt', null],
    [slugOf(second), 'skip', 'name-collision'],
  ]);
  const r = applyMigration(items, config);
  assert.equal(r.adopted, 1);
  assert.ok(lstatSync(memFirst).isSymbolicLink());
  assert.ok(lstatSync(memSecond).isDirectory());
  assert.deepEqual(readdirSync(join(repoDir, 'projects', 'example-repo')).sort(), ['.project', 'one.md']);
  // applying the unplanned pair directly also keeps them apart
  const forced = items.map((i) => ({ ...i, action: 'adopt', reason: null }));
  const r2 = applyMigration(forced, config);
  assert.equal(r2.adopted, 0);
});

test('two folders without origin and with one project name are both skipped as no-remote', (t) => {
  const base = tempDir(t);
  const claudeDir = join(base, 'claude');
  const repoDir = join(base, 'clone');
  mkdirSync(repoDir);
  const first = makeRepo(join(base, 'a', 'example-repo'), null);
  const second = makeRepo(join(base, 'b', 'example-repo'), 'file:///srv/repos/example-repo.git');
  const memFirst = join(session(claudeDir, slugOf(first), first), 'memory');
  const memSecond = join(session(claudeDir, slugOf(second), second), 'memory');
  put(memFirst, 'one.md', '1');
  put(memSecond, 'two.md', '2');
  const config = { host: 'alpha', repoDir, repoUrl: null, stateDir: join(base, 's'), claudeDir, staleAfterSeconds: 600 };
  const items = planMigration(config);
  assert.deepEqual(items.map((i) => [i.slug, i.action, i.reason]), [
    [slugOf(first), 'skip', 'no-remote'],
    [slugOf(second), 'skip', 'no-remote'],
  ]);
  const r = applyMigration(items, config);
  assert.equal(r.adopted, 0);
  assert.deepEqual(r.skipped.map((x) => x.reason), ['no-remote', 'no-remote']);
  // forcing the pair through apply still creates nothing in the clone
  const forced = items.map((i) => ({ ...i, action: 'adopt', reason: null }));
  assert.deepEqual(applyMigration(forced, config).skipped.map((x) => x.reason), ['no-remote', 'no-remote']);
  assert.ok(lstatSync(memFirst).isDirectory());
  assert.ok(lstatSync(memSecond).isDirectory());
  assert.deepEqual(readdirSync(repoDir), []);
});

function cli(config, args, extraEnv = {}) {
  const home = dirname(config.stateDir);
  const cfg = join(home, 'config.json');
  writeFileSync(cfg, JSON.stringify({ enabled: true, host: config.host, repoDir: config.repoDir, claudeDir: config.claudeDir, stateDir: config.stateDir }));
  const env = isolatedEnv(home, { AGENT_MEMORY_CONFIG: cfg, ...extraEnv });
  const started = Date.now();
  const r = spawnSync('bash', [RUN, 'migrate', ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - started };
}

// Holds the sync lock of the HOME that cli() uses until `seconds` have passed.
async function holdSyncLock(t, config, seconds) {
  const lockDir = join(dirname(config.stateDir), '.local/state/agent-memory');
  mkdirSync(lockDir, { recursive: true });
  const script = `exec 9> "$1"; flock 9; echo held; sleep ${seconds}`;
  const holder = spawn('bash', ['-c', script, 'holder', join(lockDir, 'sync.lock')], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  return holder;
}

test('run.sh migrate --dry-run lists folders, findings and a summary without changing anything', (t) => {
  const { config, base } = fixture(t, { clone: true });
  const before = tree(base);
  const r = cli(config, ['--dry-run']);
  assert.equal(r.code, 0);
  assert.match(r.out, /example-repo.*4 file/);
  assert.match(r.out, /leak\.md github-token line 7/);
  assert.match(r.out, /no-repository/);
  assert.equal(r.out.includes(token()), false);
  assert.match(r.out.trim().split('\n').at(-1), /^3 folder/);
  assert.deepEqual(tree(base).filter((p) => !p.endsWith('config.json')), before.filter((p) => !p.endsWith('config.json')));
});

test('run.sh migrate --apply prints JSON, and needs --skip-flagged when files are flagged', (t) => {
  const { config, memA } = fixture(t, { clone: true });
  const refused = cli(config, ['--apply']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /flagged files present/);
  assert.ok(lstatSync(memA).isDirectory());
  const ok = cli(config, ['--apply', '--skip-flagged']);
  assert.equal(ok.code, 0);
  const result = JSON.parse(ok.out);
  assert.equal(result.adopted, 1);
  assert.equal(result.adoptedFolders.length, 1);
  const [folder] = result.adoptedFolders;
  assert.deepEqual([folder.project, folder.leftOut], ['example-repo', ['leak.md']]);
  assert.match(folder.backupDir, /\/memory\.local-backup-\d{8}T\d{6}Z$/);
  assert.equal(read(folder.backupDir, 'leak.md').includes(token()), true);
  assert.equal(ok.out.includes(token()), false);
  assert.equal(JSON.parse(readFileSync(join(config.stateDir, 'status.json'), 'utf8')).ok, true);
});

test('run.sh migrate refuses without a clone and creates nothing', (t) => {
  const { config, base } = fixture(t);
  const missing = { ...config, repoDir: join(base, 'no-clone') };
  for (const args of [['--dry-run'], ['--apply', '--skip-flagged']]) {
    for (const cfg of [config, missing]) {
      const before = tree(base).filter((p) => !p.endsWith('config.json'));
      const r = cli(cfg, args);
      assert.equal(r.code, 1, args.join(' '));
      assert.equal(r.err, `agent-memory: ${cfg.repoDir} is not a clone; run setup.sh first.\n`);
      assert.equal(r.out, '');
      // The apply takes the sync lock first; its lock file is the only thing it may leave.
      const after = tree(base).filter((p) => !p.endsWith('config.json') && !p.startsWith(join(base, '.local')));
      assert.deepEqual(after, before.filter((p) => !p.startsWith(join(base, '.local'))));
    }
  }
  assert.equal(existsSync(missing.repoDir), false);
  assert.equal(existsSync(config.stateDir), false);
});

test('run.sh migrate --apply waits for a running sync, and gives up after the wait', async (t) => {
  const { config, memA } = fixture(t, { clone: true });
  await holdSyncLock(t, config, 30);
  const timedOut = cli(config, ['--apply', '--skip-flagged'], { AGENT_MEMORY_LOCK_WAIT_SECONDS: '1' });
  assert.equal(timedOut.code, 1);
  assert.equal(timedOut.err, 'agent-memory: a sync is running; try again.\n');
  assert.ok(timedOut.ms >= 900, `${timedOut.ms} ms`);
  assert.ok(lstatSync(memA).isDirectory());
  assert.equal(existsSync(join(config.stateDir, 'status.json')), false);
});

test('run.sh migrate --apply runs once the sync that holds the lock has finished', async (t) => {
  const { config, memA } = fixture(t, { clone: true });
  await holdSyncLock(t, config, 1);
  const r = cli(config, ['--apply', '--skip-flagged']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.ms >= 500, `${r.ms} ms`);
  assert.ok(lstatSync(memA).isSymbolicLink());
});

test('run.sh migrate --apply stops when the sync before it fails', (t) => {
  const { config, base, memA } = fixture(t, { clone: true });
  sh(config.repoDir, 'git', ['remote', 'set-url', 'origin', join(base, 'unreachable.git')]);
  const r = cli(config, ['--apply', '--skip-flagged']);
  assert.equal(r.code, 1);
  assert.match(r.err, /^agent-memory migrate: the sync before migrating failed: .+\n$/);
  assert.equal(r.out, '');
  assert.ok(lstatSync(memA).isDirectory());
  assert.equal(existsSync(join(config.repoDir, 'projects')), false);
  assert.equal(JSON.parse(readFileSync(join(config.stateDir, 'status.json'), 'utf8')).ok, false);
});

test('run.sh migrate prints usage for no flag or an unknown flag, and reports a disabled config', (t) => {
  const { config } = fixture(t, { clone: true });
  for (const args of [[], ['--bogus'], ['--dry-run', '--apply'], ['--dry-run', '--skip-flagged']]) {
    const r = cli(config, args);
    assert.equal(r.code, 2);
    assert.match(r.err, /usage: run\.sh migrate/);
  }
  const home = dirname(config.stateDir);
  const env = isolatedEnv(home, { AGENT_MEMORY_CONFIG: join(home, 'missing.json') });
  let res;
  try {
    execFileSync('bash', [RUN, 'migrate', '--dry-run'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    res = e;
  }
  assert.equal(res.status, 1);
  assert.match(res.stderr + res.stdout, /agent-memory is not enabled on this machine\./);
});
