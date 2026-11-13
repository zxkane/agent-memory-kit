import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSessionContext, isInside } from '../lib/context.mjs';
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
