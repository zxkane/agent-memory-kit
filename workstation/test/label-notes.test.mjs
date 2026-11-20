import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { CUT_MARKER, NOTE_TEXT_CAP, applyLabelEntries, collectScopeNotes } from '../lib/label-notes.mjs';
import { tempDir } from './helpers.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const HEAD = '---\nname: n\ndescription: A note\nmetadata:\n  type: project\n---\n';
const LABELED = (label) => HEAD.replace('  type: project\n', `  type: project\n  domain: ${label}\n`);

// A notes clone with the given files (path to text or bytes).
function repoWith(t, files) {
  const repo = tempDir(t);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  return repo;
}

const entry = (repo, path, label) => ({ path, label, sha256: sha(readFileSync(join(repo, path))) });

test('the note text is cut at 6,000 characters, followed by a marker', () => {
  assert.equal(NOTE_TEXT_CAP, 6000);
  assert.equal(CUT_MARKER, '\n[... cut at 6,000 characters]');
});

test('collectScopeNotes cuts a long body and marks the cut', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'exact.md'), `${HEAD}${'z'.repeat(6000)}`);
  writeFileSync(join(dir, 'long.md'), `${HEAD}${'x'.repeat(5999)}é${'y'.repeat(1000)}`);
  const [exact, long] = collectScopeNotes(dir, 'projects/p');
  assert.equal(exact.body, 'z'.repeat(6000));
  assert.equal(long.body, `${'x'.repeat(5999)}é${CUT_MARKER}`);
  // The digest is of the whole file, not of the text that was kept.
  assert.equal(long.sha256, sha(readFileSync(join(dir, 'long.md'))));
});

test('collectScopeNotes names the notes whose frontmatter setDomain cannot edit', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'a-plain.md'), 'Just a line.\n');
  writeFileSync(join(dir, 'b-open.md'), '---\nname: open\nJust a line.\n');
  writeFileSync(join(dir, 'c-inline.md'), '---\nname: inline\ndescription: Inline metadata\nmetadata: {}\n---\nBody.\n');
  writeFileSync(join(dir, 'd-good.md'), `${HEAD}Body.\n`);
  const notes = collectScopeNotes(dir, 'global');
  assert.deepEqual(notes.map((n) => [n.path, n.skip, n.name, n.description, n.body]), [
    ['global/a-plain.md', 'no frontmatter', null, null, 'Just a line.\n'],
    ['global/b-open.md', 'frontmatter not closed', null, null, '---\nname: open\nJust a line.\n'],
    ['global/c-inline.md', 'metadata is not a block', 'inline', 'Inline metadata', 'Body.\n'],
    ['global/d-good.md', null, 'n', 'A note', 'Body.\n'],
  ]);
});

test('applyLabelEntries keeps the mode of a note and leaves no temporary file', (t) => {
  const repo = repoWith(t, { 'projects/p/a.md': `${HEAD}Alpha.\n`, 'projects/p/b.md': `${HEAD}Beta.\n` });
  chmodSync(join(repo, 'projects/p/a.md'), 0o640);
  chmodSync(join(repo, 'projects/p/b.md'), 0o604);
  const entries = [entry(repo, 'projects/p/a.md', 'work'), entry(repo, 'projects/p/b.md', 'personal')];
  // A umask that would narrow a newly created file: the note's own mode is set again.
  const old = process.umask(0o077);
  let res;
  try {
    res = applyLabelEntries(repo, entries);
  } finally {
    process.umask(old);
  }
  const text = (rel) => readFileSync(join(repo, rel), 'utf8');
  assert.equal(text('projects/p/a.md'), `${LABELED('work')}Alpha.\n`);
  assert.equal(text('projects/p/b.md'), `${LABELED('personal')}Beta.\n`);
  assert.deepEqual(res, {
    written: [
      { path: 'projects/p/a.md', sha256: sha(readFileSync(join(repo, 'projects/p/a.md'))) },
      { path: 'projects/p/b.md', sha256: sha(readFileSync(join(repo, 'projects/p/b.md'))) },
    ],
    unchanged: [],
    skipped: [],
  });
  assert.equal(statSync(join(repo, 'projects/p/a.md')).mode & 0o777, 0o640);
  assert.equal(statSync(join(repo, 'projects/p/b.md')).mode & 0o777, 0o604);
  assert.deepEqual(readdirSync(join(repo, 'projects/p')).sort(), ['a.md', 'b.md']);
});

test('applyLabelEntries never reads or writes through a link', (t) => {
  const outside = repoWith(t, { 'b.md': `${HEAD}Beta.\n` });
  const repo = repoWith(t, {});
  mkdirSync(join(repo, 'projects'));
  symlinkSync(outside, join(repo, 'projects/p'));
  mkdirSync(join(repo, 'global'));
  symlinkSync(join(outside, 'b.md'), join(repo, 'global/b.md'));
  const digest = sha(readFileSync(join(outside, 'b.md')));
  const res = applyLabelEntries(repo, [
    { path: 'projects/p/b.md', label: 'work', sha256: digest },
    { path: 'global/b.md', label: 'work', sha256: digest },
  ]);
  assert.deepEqual(res.skipped, [{ path: 'projects/p/b.md', reason: 'gone' }, { path: 'global/b.md', reason: 'gone' }]);
  assert.deepEqual(res.written, []);
  assert.equal(readFileSync(join(outside, 'b.md'), 'utf8'), `${HEAD}Beta.\n`);
});

test('applyLabelEntries refuses an entry that is not a note of a scope folder before writing anything', (t) => {
  const repo = repoWith(t, { 'global/a.md': `${HEAD}Alpha.\n`, 'global/MEMORY.md': '- [a](a.md) — a\n' });
  const good = entry(repo, 'global/a.md', 'work');
  for (const bad of [{ path: 'projects/../a.md' }, { path: 'global/MEMORY.md' }, { label: 'Work' }, { sha256: 'abc' }]) {
    assert.throws(() => applyLabelEntries(repo, [good, { ...good, ...bad }]), TypeError, JSON.stringify(bad));
  }
  assert.equal(readFileSync(join(repo, 'global/a.md'), 'utf8'), `${HEAD}Alpha.\n`);
});

test('applyLabelEntries leaves a note that is not UTF-8 text as it is', (t) => {
  const bytes = Buffer.concat([Buffer.from(`${HEAD}Caf`), Buffer.from([0xe9]), Buffer.from('.\n')]);
  const repo = repoWith(t, { 'global/a.md': bytes });
  const res = applyLabelEntries(repo, [entry(repo, 'global/a.md', 'work')]);
  assert.deepEqual(res.skipped, [{ path: 'global/a.md', reason: 'not UTF-8 text' }]);
  assert.ok(readFileSync(join(repo, 'global/a.md')).equals(bytes));
});

test('applyLabelEntries tags an error after its first write as partial; one before it is not', { skip: process.getuid?.() === 0 && 'runs as root' }, (t) => {
  for (const [order, partial] of [[['projects/p/b.md', 'global/a.md'], true], [['global/a.md', 'projects/p/b.md'], undefined]]) {
    const repo = repoWith(t, { 'global/a.md': `${HEAD}Alpha.\n`, 'projects/p/b.md': `${HEAD}Beta.\n` });
    const entries = order.map((path) => entry(repo, path, 'work'));
    chmodSync(join(repo, 'global'), 0o555);
    let err = null;
    try {
      applyLabelEntries(repo, entries);
    } catch (e) {
      err = e;
    } finally {
      chmodSync(join(repo, 'global'), 0o755);
    }
    assert.equal(err?.code, 'EACCES', order.join(' '));
    assert.equal(err.partial, partial, order.join(' '));
    assert.deepEqual(err.result?.written.map((w) => w.path), partial ? ['projects/p/b.md'] : undefined, order.join(' '));
    assert.equal(readFileSync(join(repo, 'global/a.md'), 'utf8'), `${HEAD}Alpha.\n`);
  }
});
