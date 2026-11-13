import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeSlug, repoRoot, projectName, memoryLinkPath, repoIdentity } from '../lib/project.mjs';
import { isolateGit, tempDir, sh } from './helpers.mjs';

isolateGit();

function makeRepoWithWorktree(t) {
  const base = tempDir(t);
  const main = join(base, 'main');
  const worktree = join(base, 'wt');
  mkdirSync(join(main, 'sub'), { recursive: true });
  sh(main, 'git', ['init', '-b', 'main']);
  sh(main, 'git', ['config', 'user.name', 'x']);
  sh(main, 'git', ['config', 'user.email', 'x@example.com']);
  writeFileSync(join(main, 'sub', 'f'), 'x');
  sh(main, 'git', ['add', 'sub/f']);
  sh(main, 'git', ['commit', '-m', 'init']);
  sh(main, 'git', ['worktree', 'add', '-b', 'feat', worktree]);
  return { main, worktree };
}

test('sanitizeSlug replaces every non-alphanumeric character', () => {
  assert.equal(sanitizeSlug('/tmp/am_sp.kxCKMgL/proj'), '-tmp-am-sp-kxCKMgL-proj');
  assert.equal(sanitizeSlug('/home/user/.agents/skills/example-skill'), '-home-user--agents-skills-example-skill');
});

test('repoRoot of a linked worktree is the main repository root', (t) => {
  const { main, worktree } = makeRepoWithWorktree(t);
  assert.equal(repoRoot(worktree), main);
  assert.equal(repoRoot(join(main, 'sub')), main);
});

test('repoRoot is the same physical root from the root, a subdirectory, a worktree and a symlinked path', (t) => {
  const { main, worktree } = makeRepoWithWorktree(t);
  const link = join(tempDir(t), 'linked-repo');
  symlinkSync(main, link);
  for (const cwd of [main, join(main, 'sub'), worktree, join(worktree, 'sub'), link, join(link, 'sub')]) {
    assert.equal(repoRoot(cwd), main, cwd);
  }
});

test('repoRoot falls back to the work tree top when the Git directory is not named .git', (t) => {
  const base = tempDir(t);
  const work = join(base, 'work');
  mkdirSync(join(work, 'sub'), { recursive: true });
  sh(base, 'git', ['init', '-q', '--separate-git-dir', join(base, 'store.git'), work]);
  assert.equal(repoRoot(join(work, 'sub')), work);
});

test('repoRoot is null outside a repository and for a missing directory', (t) => {
  assert.equal(repoRoot(tempDir(t)), null);
  assert.equal(repoRoot('/nonexistent/xyz'), null);
});

test('projectName accepts ordinary names and rejects unsafe ones', () => {
  assert.equal(projectName('/srv/repos/Example-Repo'), 'Example-Repo');
  assert.equal(projectName('/srv/repos/example-repo'), 'example-repo');
  for (const bad of ['/x/-dash', '/x/.hidden', '/x/a b', '/']) assert.equal(projectName(bad), null);
});

test('memoryLinkPath joins claudeDir, slug and memory', () => {
  assert.equal(memoryLinkPath('/h/.claude', '/srv/repos/example-repo'), '/h/.claude/projects/-srv-repos-example-repo/memory');
});

function repoWithOrigin(t, url) {
  const dir = join(tempDir(t), 'r');
  mkdirSync(dir);
  sh(dir, 'git', ['init']);
  if (url !== null) sh(dir, 'git', ['remote', 'add', 'origin', url]);
  return dir;
}

test('repoIdentity normalizes origin URLs', (t) => {
  const withCredentials = `https://${'us' + 'er'}:${'p' + 'w'}@EXAMPLE.com/Owner/Repo.git/`;
  const cases = {
    'git@example.com:Owner/Repo.git': 'example.com/Owner/Repo',
    'deploy@Example.com:Owner/Repo': 'example.com/Owner/Repo',
    'ssh://git@example.com/Owner/Repo': 'example.com/Owner/Repo',
    'ssh://git@example.com:2222/Owner/Repo.git': 'example.com/Owner/Repo',
    'git://example.com/Owner/Repo.git': 'example.com/Owner/Repo',
    'http://example.com:8080/Owner/Repo': 'example.com/Owner/Repo',
    [withCredentials]: 'example.com/Owner/Repo',
    'https://example.com/Owner/Repo': 'example.com/Owner/Repo',
  };
  for (const [url, want] of Object.entries(cases)) assert.equal(repoIdentity(repoWithOrigin(t, url)), want);
});

test('repoIdentity is null without origin, for a local path and for file URLs', (t) => {
  assert.equal(repoIdentity(repoWithOrigin(t, null)), null);
  for (const url of ['/srv/repos/x.git', 'file:///srv/repos/x.git', 'C:\\repos\\x', 'C:/repos/x', '../x.git', 'x.git']) {
    assert.equal(repoIdentity(repoWithOrigin(t, url)), null, url);
  }
});

test('repoIdentity is null outside a repository', (t) => {
  assert.equal(repoIdentity(tempDir(t)), null);
});

test('repoIdentity never lets part of a credential into the identity', (t) => {
  const user = 'us' + 'er';
  const slashPw = `${'pa'}/${'ss'}`;
  const atPw = `${'pa'}@${'ss'}`;
  const cases = {
    [`https://${user}:${slashPw}@example.com/Owner/Repo`]: null,
    [`https://${user}/${slashPw}@example.com/Owner/Repo`]: null,
    [`${user}:${slashPw}@example.com:Owner/Repo`]: null,
    [`https://${user}:${atPw}@example.com/Owner/Repo`]: 'example.com/Owner/Repo',
    [`ssh://${user}:${atPw}@example.com:2222/Owner/Repo`]: 'example.com/Owner/Repo',
  };
  for (const [url, want] of Object.entries(cases)) {
    const got = repoIdentity(repoWithOrigin(t, url));
    assert.equal(got, want);
  }
});
