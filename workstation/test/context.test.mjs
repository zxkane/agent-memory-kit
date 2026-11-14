import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_BUDGET, buildSessionContext, buildToolContext, isInside, textCost } from '../lib/context.mjs';
import { tempDir } from './helpers.mjs';

function fixture(t) {
  const tmp = tempDir(t);
  const repo = join(tmp, 'clone');
  mkdirSync(join(repo, 'global'), { recursive: true });
  mkdirSync(join(repo, 'projects', 'p'), { recursive: true });
  const cfg = { host: 'alpha', repoDir: repo, repoUrl: null, stateDir: join(tmp, 'state'), claudeDir: join(tmp, 'claude'), staleAfterSeconds: 600 };
  const fresh = { ok: true, lastRun: '2026-11-13T07:04:00.000Z', lastSuccess: '2026-11-13T07:04:00.000Z', quarantineCount: 0, conflictCount: 0 };
  const base = { config: cfg, status: fresh, project: 'example-repo', repoOk: true, now: new Date('2026-11-13T07:05:00Z') };
  const writeGlobal = (text) => writeFileSync(join(repo, 'global', 'MEMORY.md'), text);
  return { tmp, repo, cfg, fresh, base, writeGlobal };
}

test('healthy state prints the two fixed lines and the global index', (t) => {
  const { repo, base, writeGlobal } = fixture(t);
  writeGlobal('- [Prefs](prefs.md) — keep replies short\n');
  assert.equal(buildSessionContext(base), [
    `Shared memory is on. Notes under ${repo} are synced between machines every few minutes.`,
    `Facts that apply across projects belong in ${repo}/global/, in the same format as project memory: one fact per file plus one line in MEMORY.md.`,
    'Global index:', '- [Prefs](prefs.md) — keep replies short', '',
  ].join('\n'));
});

test('a missing global index prints (empty)', (t) => {
  const { base } = fixture(t);
  assert.match(buildSessionContext(base), /Global index:\n\(empty\)\n$/);
});

test('an unusable clone prints only the warning', (t) => {
  const { repo, base } = fixture(t);
  assert.equal(buildSessionContext({ ...base, repoOk: false }),
    `WARNING: shared memory is enabled but ${repo} is not a usable clone. Notes written now stay local. Run setup.sh from agent-memory-kit.\n`);
});

test('stale sync, quarantine, conflicts and no project each add their line', (t) => {
  const { cfg, base, fresh } = fixture(t);
  const out = buildSessionContext({ ...base, project: null, status: { ...fresh, lastSuccess: '2026-11-13T06:00:00.000Z', quarantineCount: 2, conflictCount: 1 } });
  assert.match(out, /This directory is not inside a Git repository, so its memory stays on this machine\./);
  assert.match(out, /WARNING: memory sync has not succeeded since 2026-11-13T06:00:00.000Z\. Notes written now stay on this machine until it recovers\./);
  assert.match(out, new RegExp(`WARNING: the secret scan set aside 2 file\\(s\\) in ${cfg.stateDir}/quarantine\\. Review them\\.`));
  assert.match(out, /Note: 1 note\(s\) changed on two machines; both versions were kept as \*\.conflict-\*\.md\./);
});

test('project folders claimed by another repository on another machine add a warning', (t) => {
  const { cfg, base, fresh } = fixture(t);
  const out = buildSessionContext({ ...base, status: { ...fresh, markerConflicts: ['projects/p', 'projects/q'] } });
  assert.match(out, new RegExp(`\\nWARNING: 2 project folder\\(s\\) were claimed by a different repository on another machine\\. Notes written here before that may be mixed in; see ${cfg.stateDir}/status\\.json\\.\\n`));
  assert.doesNotMatch(buildSessionContext({ ...base, status: { ...fresh, markerConflicts: [] } }), /claimed by a different repository/);
});

test('no status at all counts as a sync that never succeeded', (t) => {
  const { base } = fixture(t);
  assert.match(buildSessionContext({ ...base, status: null }), /has not succeeded since it was set up\./);
});

test('a healthy state has none of the warning lines', (t) => {
  const { base } = fixture(t);
  assert.doesNotMatch(buildSessionContext(base), /WARNING|Note:|not inside a Git/);
});

test('never exceeds the cap and says where the rest is', (t) => {
  const { repo, base, writeGlobal } = fixture(t);
  writeGlobal('- line\n'.repeat(5000));
  const out = buildSessionContext({ ...base, cap: 2000 });
  assert.ok(out.length <= 2000);
  assert.ok(out.trimEnd().endsWith(`[truncated; full index: ${repo}/global/MEMORY.md]`));
  assert.match(out, /\n- line\n\[truncated/);
});

test('the default cap is 9000 characters', (t) => {
  const { base, writeGlobal } = fixture(t);
  writeGlobal('- line\n'.repeat(5000));
  const out = buildSessionContext(base);
  assert.ok(out.length <= 9000);
  assert.match(out, /\[truncated; full index: /);
});

test('isInside follows a symlinked memory folder into the clone', (t) => {
  const { tmp, repo } = fixture(t);
  const link = join(tmp, 'link');
  symlinkSync(join(repo, 'projects', 'p'), link);
  assert.equal(isInside(join(link, 'new-note.md'), repo), true);
  assert.equal(isInside(join(link, 'sub', 'deeper', 'new-note.md'), repo), true);
  assert.equal(isInside('/etc/hosts', repo), false);
});

test('isInside rejects a sibling directory that shares the clone name as a prefix', (t) => {
  const { tmp, repo } = fixture(t);
  mkdirSync(`${repo}-other`);
  assert.equal(isInside(join(`${repo}-other`, 'n.md'), repo), false);
  assert.equal(isInside(join(tmp, 'clone', '..', 'elsewhere.md'), repo), false);
});

test('a name collision is explained and a broken binding is a warning', (t) => {
  const { base } = fixture(t);
  assert.match(buildSessionContext({ ...base, identity: { reason: 'mismatch', expected: 'example.com/a/app', linked: false } }),
    /This repository shares its name with another project in shared memory \(example\.com\/a\/app\), so its memory stays on this machine\./);
  assert.match(buildSessionContext({ ...base, identity: { reason: 'mismatch', expected: 'example.com/a/app', linked: true } }),
    /WARNING: this repository's remote no longer matches the project its memory is linked to \(example\.com\/a\/app\)\./);
});

test('a repository without a shareable origin is told that its memory stays local', (t) => {
  const { base } = fixture(t);
  const out = buildSessionContext({ ...base, identity: { reason: 'no-identity', expected: null, linked: false } });
  assert.match(out, /\nThis repository has no shareable "origin" remote, so its memory stays on this machine\.\n/);
  assert.doesNotMatch(out, /not inside a Git repository/);
});

test('other identity results leave the text unchanged', (t) => {
  const { base } = fixture(t);
  const plain = buildSessionContext(base);
  for (const reason of ['bound', 'match']) {
    assert.equal(buildSessionContext({ ...base, identity: { reason, expected: null, linked: true } }), plain);
  }
});

test('an unusable directory name is told apart from being outside a repository', (t) => {
  const { base } = fixture(t);
  const out = buildSessionContext({ ...base, project: null, unusableName: true });
  assert.match(out, /\nThis repository's directory name cannot be used as a project name, so its memory stays on this machine\.\n/);
  assert.doesNotMatch(out, /not inside a Git repository/);
});

test('a memory folder that could not be linked says why', (t) => {
  const { base } = fixture(t);
  const out = buildSessionContext({ ...base, linkSkipped: 'nested-entries' });
  assert.match(out, /\nThis repository's memory folder could not be linked \(nested-entries\), so its memory stays on this machine\.\n/);
  assert.doesNotMatch(buildSessionContext(base), /could not be linked/);
});

test('the identity from a marker is cut to its first line and 200 characters', (t) => {
  const { base } = fixture(t);
  const long = `example.com/${'x'.repeat(400)}`;
  for (const linked of [false, true]) {
    const multi = buildSessionContext({ ...base, identity: { reason: 'mismatch', expected: 'example.com/a/app\nsecond line', linked } });
    assert.match(multi, /\(example\.com\/a\/app\)/);
    assert.doesNotMatch(multi, /second line/);
    const cut = buildSessionContext({ ...base, identity: { reason: 'mismatch', expected: long, linked } });
    assert.ok(cut.includes(`(${long.slice(0, 200)})`));
    assert.equal(cut.includes(long.slice(0, 201)), false);
  }
});

test('the output never exceeds the cap, even when the fixed lines alone are longer', (t) => {
  const { base, cfg, writeGlobal } = fixture(t);
  const longRepo = `/srv/${'r'.repeat(3000)}`;
  const config = { ...cfg, repoDir: longRepo, stateDir: `/srv/${'s'.repeat(3000)}` };
  const status = { ...base.status, quarantineCount: 1, markerConflicts: ['projects/p'], lastSuccess: null };
  for (const cap of [500, 2000, 9000]) {
    const out = buildSessionContext({ ...base, config, status, cap });
    assert.ok(out.length <= cap, `cap ${cap}: ${out.length}`);
    assert.ok(out.startsWith('Shared memory is on.'));
  }
  writeGlobal('- line\n'.repeat(10));
  assert.ok(buildSessionContext({ ...base, config, status, cap: 2000 }).length <= 2000);
  assert.ok(buildSessionContext({ ...base, repoOk: false, config, cap: 100 }).length <= 100);
});

// ---- buildToolContext (Codex and Kiro) ----

const toolFixture = (t) => {
  const f = fixture(t);
  const writeProject = (text) => writeFileSync(join(f.repo, 'projects', 'p', 'MEMORY.md'), text);
  const tool = { ...f.base, project: 'p' };
  return { ...f, writeProject, tool };
};
const bulk = (n, text) => Array.from({ length: n }, (_, i) => `${i} ${text}`).join('\n') + '\n';
const indexLines = (out, from, to) => {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.startsWith(from)) + 1;
  const end = to === undefined ? lines.length : lines.findIndex((l) => l.startsWith(to));
  return lines.slice(start, end).filter((l) => l !== '');
};

test('textCost counts ASCII as 1 and every other code unit as 5', () => {
  assert.equal(textCost('abc'), 3);
  assert.equal(textCost('记忆'), 10);
  assert.equal(textCost('a记'), 6);
  assert.equal(textCost(''), 0);
  assert.equal(TOOL_BUDGET, 7200);
});

test('tool context: project and global index, exact text', (t) => {
  const { repo, tool, writeProject, writeGlobal } = toolFixture(t);
  writeProject('- [A](a.md) — alpha\n');
  writeGlobal('- [B](b.md) — beta\n- [C](c.md) — gamma\n');
  assert.equal(buildToolContext(tool), [
    `Shared memory is on. Notes under ${repo} are synced between machines every few minutes.`,
    `Project notes for this repository: ${repo}/projects/p/ — notes for all projects: ${repo}/global/.`,
    'To remember a fact, add one Markdown file with `name`, `description` and `metadata.type` (user, feedback, project or reference) frontmatter, and one line for it in that folder\'s MEMORY.md. Open a note when its index line is relevant.',
    `Project index (${repo}/projects/p/MEMORY.md):`,
    '- [A](a.md) — alpha',
    `Global index (${repo}/global/MEMORY.md):`,
    '- [B](b.md) — beta', '- [C](c.md) — gamma', '',
  ].join('\n'));
});

test('tool context: empty and missing indexes print (empty)', (t) => {
  const { repo, tool, writeGlobal } = toolFixture(t);
  writeGlobal('');
  const out = buildToolContext(tool);
  assert.match(out, new RegExp(`Project index \\(${repo}/projects/p/MEMORY\\.md\\):\\n\\(empty\\)\\nGlobal index \\(${repo}/global/MEMORY\\.md\\):\\n\\(empty\\)\\n$`));
});

for (const [reason, expected, line] of [
  ['not-a-repository', null, 'This directory is not inside a Git repository, so it has no project notes.'],
  ['unusable-name', null, "This repository's directory name cannot be used as a project name, so it has no project notes."],
  ['no-identity', null, 'This repository has no shareable "origin" remote, so it has no project notes.'],
  ['mismatch', 'x'.repeat(300), `This repository shares its name with another project in shared memory (${'x'.repeat(200)}), so it has no project notes.`],
  ['mismatch', null, 'This repository shares its name with another project in shared memory, so it has no project notes.'],
]) {
  test(`tool context: no project, ${reason}${expected === null ? '' : ' with identity'}`, (t) => {
    const { repo, base, writeGlobal } = toolFixture(t);
    writeGlobal('- g\n');
    const lines = buildToolContext({ ...base, project: null, reason, expected }).split('\n');
    assert.equal(lines[1], `Notes for all projects: ${repo}/global/.`);
    assert.equal(lines[3], line);
    assert.ok(!lines.some((l) => l.startsWith('Project index')));
    assert.equal(lines[4], `Global index (${repo}/global/MEMORY.md):`);
  });
}

test('tool context: repo not usable', (t) => {
  const { base } = toolFixture(t);
  const args = { ...base, repoOk: false };
  assert.equal(buildToolContext(args), buildSessionContext(args));
});

test('tool context: status lines match the Claude builder', (t) => {
  const { base, fresh } = toolFixture(t);
  const status = { ...fresh, lastSuccess: '2026-11-13T06:00:00.000Z', quarantineCount: 2, markerConflicts: ['a'], conflictCount: 3 };
  const claude = buildSessionContext({ ...base, status }).split('\n').filter((l) => /^(WARNING|Note):/.test(l));
  assert.equal(claude.length, 4);
  const tool = buildToolContext({ ...base, project: 'p', status }).split('\n');
  const positions = claude.map((l) => tool.indexOf(l));
  assert.ok(positions.every((p) => p >= 0), 'every status line present');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test('tool context: both indexes too long', (t) => {
  const { repo, tool, writeProject, writeGlobal } = toolFixture(t);
  const text = bulk(400, 'x'.repeat(58));
  writeProject(text);
  writeGlobal(text);
  const out = buildToolContext(tool);
  assert.ok(textCost(out) <= TOOL_BUDGET);
  assert.ok(out.includes(`[truncated; full index: ${repo}/projects/p/MEMORY.md]\n`));
  assert.ok(out.includes(`[truncated; full index: ${repo}/global/MEMORY.md]\n`));
  const source = new Set(text.trimEnd().split('\n'));
  const proj = indexLines(out, 'Project index', 'Global index').filter((l) => !l.startsWith('[truncated'));
  const glob = indexLines(out, 'Global index').filter((l) => !l.startsWith('[truncated'));
  for (const l of [...proj, ...glob]) assert.ok(source.has(l), `complete line: ${l}`);
  assert.ok(proj.length >= 20 && glob.length >= 20);
});

test('tool context: a short index leaves its share to the long one', (t) => {
  const { tool, writeProject, writeGlobal } = toolFixture(t);
  const text = bulk(400, 'x'.repeat(58));
  writeProject(text);
  writeGlobal(text);
  const both = indexLines(buildToolContext(tool), 'Global index').length;
  writeProject('- a\n- b\n- c\n');
  const out = buildToolContext(tool);
  assert.ok(textCost(out) <= TOOL_BUDGET);
  assert.ok(indexLines(out, 'Global index').length > both);
  assert.ok(!/Project index[^\n]*\n(?:[^\n]*\n)*?\[truncated[^\n]*\nGlobal index/.test(out));
  assert.deepEqual(indexLines(out, 'Project index', 'Global index'), ['- a', '- b', '- c']);
});

test('tool context: non-ASCII lines cost five times as much', (t) => {
  const { base, writeGlobal } = toolFixture(t);
  writeGlobal(bulk(400, '记'.repeat(58)));
  const out = buildToolContext({ ...base, project: null, reason: 'not-a-repository' });
  assert.ok(textCost(out) <= TOOL_BUDGET);
  const n = indexLines(out, 'Global index').filter((l) => !l.startsWith('[truncated')).length;
  assert.ok(n > 0 && n < 30, `printed ${n}`);
});

test('tool context: custom budget', (t) => {
  const { repo, tool, writeProject, writeGlobal } = toolFixture(t);
  writeProject(bulk(400, 'x'.repeat(58)));
  writeGlobal(bulk(400, 'x'.repeat(58)));
  const out = buildToolContext({ ...tool, budget: 1100 });
  assert.ok(textCost(out) <= 1100);
  assert.ok(out.includes(`[truncated; full index: ${repo}/projects/p/MEMORY.md]\n`));
  assert.ok(out.includes(`[truncated; full index: ${repo}/global/MEMORY.md]\n`));
});

test('tool context: fixed text over budget', (t) => {
  const { repo, tool, writeProject, writeGlobal } = toolFixture(t);
  writeProject(bulk(10, 'x'));
  writeGlobal(bulk(10, 'x'));
  const full = buildToolContext({ ...tool, budget: 100000 });
  const out = buildToolContext({ ...tool, budget: 50 });
  assert.ok(textCost(out) <= 50);
  assert.equal(out.length, 50);
  assert.ok(out.endsWith('\n'));
  assert.ok(full.startsWith(out.slice(0, -1)));
  assert.ok(out.startsWith(`Shared memory is on. Notes under ${repo}`.slice(0, 49)));
});

test('tool context: the whole output fits any budget and ends in a newline', (t) => {
  const { base, cfg, tmp, writeGlobal } = toolFixture(t);
  writeGlobal(bulk(50, '记忆😀 note'));
  const odd = { ...base, config: { ...cfg, repoDir: join(tmp, '😀记忆😀', 'clone') } };
  const cases = [
    { ...odd, project: 'p' },
    { ...odd, project: null, reason: 'mismatch', expected: '😀'.repeat(20) },
    { ...odd, repoOk: false },
  ];
  for (const args of cases) {
    for (let budget = 1; budget <= 300; budget++) {
      const out = buildToolContext({ ...args, budget });
      assert.ok(textCost(out) <= budget, `budget ${budget}: cost ${textCost(out)}`);
      assert.ok(out.isWellFormed(), `budget ${budget}: lone surrogate`);
      assert.ok(out.endsWith('\n'), `budget ${budget}: no final newline`);
    }
  }
  assert.equal(buildToolContext({ ...odd, project: 'p', budget: 0 }), '');
});
