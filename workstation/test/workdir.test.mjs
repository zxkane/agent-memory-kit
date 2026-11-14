import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, rmSync as rmSyncSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply, evaluate, liveDiffers, snapshot } from '../lib/workdir.mjs';
import { tempDir } from './helpers.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');

function write(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}

// Live folders for `notes` (and `global` when given), a snapshot and the folder pairs.
function setup(t, { notes = {}, global = null } = {}) {
  const base = tempDir(t);
  const pairs = [{ label: 'notes', liveDir: join(base, 'live', 'notes'), workDir: join(base, 'work', 'notes') }];
  write(pairs[0].liveDir, notes);
  if (global) {
    pairs.push({ label: 'global', liveDir: join(base, 'live', 'global'), workDir: join(base, 'work', 'global') });
    write(pairs[1].liveDir, global);
  }
  mkdirSync(join(base, 'work'));
  const snap = snapshot(pairs);
  const dirOf = (label) => pairs.find((p) => p.label === label);
  return {
    base, pairs, snap,
    work: (label, file, text) => writeFileSync(join(dirOf(label).workDir, file), text),
    live: (label, file) => join(dirOf(label).liveDir, file),
    workPath: (label, file) => join(dirOf(label).workDir, file),
  };
}

const INDEX_AB = '- [A](a.md) — a\n- [B](b.md) — b\n';
const BASE_NOTES = { 'MEMORY.md': INDEX_AB, 'a.md': 'note a\n', 'b.md': 'note b\n' };
const FAKE_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';

test('snapshot copies only note files and returns their hashes', (t) => {
  const base = tempDir(t);
  const liveDir = join(base, 'live');
  const workDir = join(base, 'work');
  write(liveDir, { 'MEMORY.md': '- [A](a.md) — a\n', 'a.md': 'alpha', '.project': 'x', 'x.txt': 'text', 'notes.json': '{}' });
  mkdirSync(join(liveDir, 'sub.md'));
  write(join(liveDir, 'sub.md'), { 'inner.md': 'inner' });
  writeFileSync(join(base, 'outside.md'), 'outside');
  symlinkSync(join(base, 'outside.md'), join(liveDir, 'link.md'));
  const snap = snapshot([{ label: 'notes', liveDir, workDir }]);
  assert.deepEqual(snap, { notes: { 'MEMORY.md': sha('- [A](a.md) — a\n'), 'a.md': sha('alpha') } });
  assert.deepEqual(readdirSync(workDir).sort(), ['MEMORY.md', 'a.md']);
  assert.equal(readFileSync(join(workDir, 'a.md'), 'utf8'), 'alpha');
  assert.equal(statSync(workDir).mode & 0o777, 0o700);
});

test('snapshot of a missing live folder gives an empty work folder', (t) => {
  const base = tempDir(t);
  const workDir = join(base, 'work');
  const snap = snapshot([{ label: 'notes', liveDir: join(base, 'absent'), workDir }]);
  assert.deepEqual(snap, { notes: {} });
  assert.deepEqual(readdirSync(workDir), []);
});

test('no change gives ok and no changes', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.ignored, []);
  assert.deepEqual(r.stats.notes, { indexBefore: { lines: 2, bytes: Buffer.byteLength(INDEX_AB) }, indexAfter: { lines: 2, bytes: Buffer.byteLength(INDEX_AB) }, unlistedBefore: 0, unlistedAfter: 0 });
});

test('a snapshot file missing from the work folder counts as unchanged', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  rmSyncSync(s.workPath('notes', 'a.md'));
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changes, []);
});

test('add, change and retire are reported with kinds and target; stats follow the index', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'a.md', 'note a changed\n');
  s.work('notes', 'c.md', 'new note c\n');
  s.work('notes', 'b.md', 'MOVED TO [[c]]\n');
  s.work('notes', 'MEMORY.md', '- [A](a.md) — a\n- [C](c.md) — c\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  const byFile = Object.fromEntries(r.changes.map((c) => [c.file, c]));
  assert.equal(byFile['a.md'].kind, 'change');
  assert.equal(byFile['c.md'].kind, 'add');
  assert.equal(byFile['MEMORY.md'].kind, 'change');
  assert.deepEqual(byFile['b.md'], { label: 'notes', file: 'b.md', kind: 'retire', target: { label: 'notes', file: 'c.md' } });
  assert.equal(r.changes.length, 4);
  assert.equal(r.stats.notes.indexBefore.lines, 2);
  assert.equal(r.stats.notes.indexAfter.lines, 2);
  assert.equal(r.stats.notes.unlistedBefore, 0);
  assert.equal(r.stats.notes.unlistedAfter, 0);
});

test('a note whose index line is removed raises the unlisted count', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'd.md', 'new note d\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.equal(r.stats.notes.unlistedBefore, 0);
  assert.equal(r.stats.notes.unlistedAfter, 1);
  assert.ok(r.errors.some((e) => e.startsWith('notes/') && /index/.test(e)));
});

test('an existing unlisted note does not block an unrelated change', (t) => {
  const s = setup(t, { notes: { ...BASE_NOTES, 'x.md': 'unlisted\n' } });
  s.work('notes', 'a.md', 'changed\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, true);
  assert.equal(r.stats.notes.unlistedBefore, 1);
  assert.equal(r.stats.notes.unlistedAfter, 1);
});

test('rule 1: a subfolder, a symbolic link and a foreign name are errors', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  mkdirSync(s.workPath('notes', 'sub'));
  writeFileSync(join(s.base, 'out.md'), 'out');
  symlinkSync(join(s.base, 'out.md'), s.workPath('notes', 'link.md'));
  s.work('notes', 'notes.json', '{}');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  for (const name of ['sub', 'link.md', 'notes.json']) {
    assert.ok(r.errors.some((e) => e.startsWith(`notes/${name}:`)), `missing error for ${name}: ${r.errors}`);
  }
});

test('a symbolic link replacing a snapshot note is an error, not a change', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  writeFileSync(join(s.base, 'out.md'), 'note a\n');
  rmSyncSync(s.workPath('notes', 'a.md'));
  symlinkSync(join(s.base, 'out.md'), s.workPath('notes', 'a.md'));
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.changes, []);
});

test('rule 3: a stub of MEMORY.md is an error', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'MEMORY.md', 'MOVED TO [[a]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('notes/MEMORY.md:')));
  assert.ok(!r.changes.some((c) => c.kind === 'retire'));
});

test('rule 3: a stub of MEMORY.md is an error also when retirement is off', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'MEMORY.md', 'MOVED TO [[a]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: false });
  assert.equal(r.ok, false);
});

test('rule 3: a stub naming a missing note is an error', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'b.md', 'MOVED TO [[nowhere]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('notes/b.md:')));
});

test('rule 3: a stub naming a stub is an error', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'a.md', 'MOVED TO [[b]]\n');
  s.work('notes', 'b.md', 'MOVED TO [[a]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
});

test('rule 3: a stub naming an earlier stub that was unchanged is an error', (t) => {
  const s = setup(t, { notes: { ...BASE_NOTES, 'old.md': 'MOVED TO [[a]]\n' } });
  s.work('notes', 'b.md', 'MOVED TO [[old]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
});

test('rule 3: a stub naming itself is an error', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'b.md', 'MOVED TO [[b]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
});

test('rule 3: a stub naming MEMORY is an error', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'b.md', 'MOVED TO [[MEMORY]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
});

test('rule 3: global: without a global pair is an error', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'b.md', 'MOVED TO [[global:b]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('notes/b.md:')));
});

test('rule 3: global: used inside global is an error', (t) => {
  const s = setup(t, { notes: BASE_NOTES, global: { 'MEMORY.md': '- [G](g.md) — g\n- [H](h.md) — h\n', 'g.md': 'g', 'h.md': 'h' } });
  s.work('global', 'g.md', 'MOVED TO [[global:h]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('global/g.md:')));
});

test('retirement to global:name is valid; apply writes the global note and deletes the project note', (t) => {
  const s = setup(t, { notes: BASE_NOTES, global: { 'MEMORY.md': '', 'g.md': 'g\n' } });
  s.work('global', 'shared.md', 'shared content\n');
  s.work('global', 'MEMORY.md', '- [G](g.md) — g\n- [S](shared.md) — s\n');
  s.work('notes', 'b.md', 'MOVED TO [[global:shared]]\n');
  s.work('notes', 'MEMORY.md', '- [A](a.md) — a\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  const retire = r.changes.find((c) => c.kind === 'retire');
  assert.deepEqual(retire.target, { label: 'global', file: 'shared.md' });
  apply({ pairs: s.pairs, changes: r.changes });
  assert.equal(readFileSync(s.live('global', 'shared.md'), 'utf8'), 'shared content\n');
  assert.equal(existsSync(s.live('notes', 'b.md')), false);
  assert.equal(existsSync(s.live('notes', 'a.md')), true);
});

test('a stub may name a note the model created in the same run', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'merged.md', 'merged\n');
  s.work('notes', 'a.md', 'MOVED TO [[merged]]\n');
  s.work('notes', 'MEMORY.md', '- [B](b.md) — b\n- [M](merged.md) — m\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
});

test('a new file that is a stub is ignored, not an error', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'fresh.md', 'MOVED TO [[a]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.ignored, ['notes/fresh.md']);
});

test('with allowRetire false a retirement is ignored and the live note survives apply', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'a.md', 'edited a\n');
  s.work('notes', 'b.md', 'MOVED TO [[a]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: false });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ignored, ['notes/b.md']);
  assert.deepEqual(r.changes.map((c) => c.file), ['a.md']);
  apply({ pairs: s.pairs, changes: r.changes });
  assert.equal(readFileSync(s.live('notes', 'b.md'), 'utf8'), 'note b\n');
  assert.equal(readFileSync(s.live('notes', 'a.md'), 'utf8'), 'edited a\n');
  assert.equal(r.stats.notes.unlistedAfter, 0);
});

test('rule 4: a note of 100,001 bytes is an error, 100,000 is fine', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'a.md', 'x'.repeat(100000));
  assert.equal(evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true }).ok, true);
  s.work('notes', 'a.md', 'x'.repeat(100001));
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('notes/a.md:')));
});

test('rule 4: a credential is an error and never appears in errors', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'a.md', `key ${FAKE_KEY} here\n`);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('notes/a.md:')));
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY));
  assert.ok(!r.changes.some((c) => c.file === 'a.md'));
});

test('rule 4: MEMORY.md may not be emptied while other notes exist', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'MEMORY.md', '  \n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('notes/MEMORY.md:')));
});

test('rule 4: MEMORY.md may be empty when no non-stub note remains', (t) => {
  const s = setup(t, { notes: { 'MEMORY.md': '- [A](a.md) — a\n', 'a.md': 'a\n', 'old.md': 'MOVED TO [[a]]\n' } });
  s.work('notes', 'MEMORY.md', '');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.ok(r.errors.some((e) => e.startsWith('notes/MEMORY.md:')), 'a.md is still a note');
  const t2 = setup(t, { notes: { 'MEMORY.md': '\n', 'old.md': 'MOVED TO [[a]]\n' } });
  t2.work('notes', 'MEMORY.md', '');
  assert.equal(evaluate({ pairs: t2.pairs, snap: t2.snap, allowRetire: true }).ok, true);
});

test('rule 5: an added note with no index line is an error', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'extra.md', 'extra\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.equal(r.stats.notes.unlistedAfter, 1);
});

test('rule 5 applies per folder', (t) => {
  const s = setup(t, { notes: BASE_NOTES, global: { 'MEMORY.md': '- [G](g.md) — g\n', 'g.md': 'g\n' } });
  s.work('global', 'extra.md', 'extra\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('global/')));
  assert.equal(r.stats.global.unlistedAfter, 1);
  assert.equal(r.stats.notes.unlistedAfter, 0);
});

test('errors name files and rules only, never content', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'a.md', `secret ${FAKE_KEY}\n`);
  s.work('notes', 'b.md', 'MOVED TO [[missing-private-name]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.ok(r.errors.length >= 2);
  assert.ok(!r.errors.join('\n').includes(FAKE_KEY));
  for (const e of r.errors) assert.match(e, /^(notes|global)\/[^:]+: /);
});

test('liveDiffers lists edited, added and removed live notes; untouched gives none', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  assert.deepEqual(liveDiffers(s.pairs, s.snap), []);
  writeFileSync(s.live('notes', 'a.md'), 'edited\n');
  writeFileSync(s.live('notes', 'new.md'), 'new\n');
  rmSyncSync(s.live('notes', 'b.md'));
  assert.deepEqual(liveDiffers(s.pairs, s.snap).sort(), ['notes/a.md', 'notes/b.md', 'notes/new.md']);
});

test('liveDiffers ignores non-note files and sees a missing live folder as removal', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  writeFileSync(s.live('notes', '.project'), 'x');
  writeFileSync(s.live('notes', 'x.txt'), 'x');
  assert.deepEqual(liveDiffers(s.pairs, s.snap), []);
  rmSyncSync(s.pairs[0].liveDir, { recursive: true });
  assert.deepEqual(liveDiffers(s.pairs, s.snap).sort(), ['notes/MEMORY.md', 'notes/a.md', 'notes/b.md']);
});

test('apply writes changes, keeps untouched files byte- and mtime-identical, and a fresh snapshot matches the work folders', (t) => {
  const s = setup(t, { notes: { ...BASE_NOTES, 'keep.md': 'keep\n' }, global: { 'MEMORY.md': '- [G](g.md) — g\n', 'g.md': 'g\n' } });
  const old = new Date('2020-01-01T00:00:00Z');
  utimesSync(s.live('notes', 'keep.md'), old, old);
  const before = statSync(s.live('notes', 'keep.md')).mtimeMs;
  s.work('notes', 'a.md', 'a edited\n');
  s.work('notes', 'c.md', 'c new\n');
  s.work('notes', 'b.md', 'MOVED TO [[c]]\n');
  s.work('notes', 'MEMORY.md', '- [A](a.md) — a\n- [C](c.md) — c\n- [K](keep.md) — k\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  apply({ pairs: s.pairs, changes: r.changes });
  assert.equal(readFileSync(s.live('notes', 'keep.md'), 'utf8'), 'keep\n');
  assert.equal(statSync(s.live('notes', 'keep.md')).mtimeMs, before);
  assert.equal(existsSync(s.live('notes', 'b.md')), false);
  assert.deepEqual(readdirSync(s.pairs[0].liveDir).sort(), ['MEMORY.md', 'a.md', 'c.md', 'keep.md']);
  const fresh = snapshot(s.pairs.map((p) => ({ ...p, workDir: join(s.base, 'check', p.label) })));
  const expected = {};
  for (const p of s.pairs) {
    expected[p.label] = {};
    for (const f of readdirSync(p.workDir)) {
      if (p.label === 'notes' && f === 'b.md') continue;
      expected[p.label][f] = sha(readFileSync(join(p.workDir, f)));
    }
  }
  assert.deepEqual(fresh, expected);
});

test('apply creates a missing live folder and leaves no temporary file', (t) => {
  const s = setup(t, { notes: {} });
  rmSyncSync(s.pairs[0].liveDir, { recursive: true, force: true });
  s.work('notes', 'MEMORY.md', '- [N](n.md) — n\n');
  s.work('notes', 'n.md', 'n\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  apply({ pairs: s.pairs, changes: r.changes });
  assert.deepEqual(readdirSync(s.pairs[0].liveDir).sort(), ['MEMORY.md', 'n.md']);
});

test('apply replaces a symbolic link at the destination instead of writing through it', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  const outside = join(s.base, 'outside.md');
  writeFileSync(outside, 'outside original\n');
  rmSyncSync(s.live('notes', 'a.md'));
  symlinkSync(outside, s.live('notes', 'a.md'));
  s.work('notes', 'a.md', 'new a\n');
  apply({ pairs: s.pairs, changes: [{ label: 'notes', file: 'a.md', kind: 'change' }] });
  assert.equal(readFileSync(outside, 'utf8'), 'outside original\n');
  assert.equal(lstatSync(s.live('notes', 'a.md')).isSymbolicLink(), false);
  assert.equal(readFileSync(s.live('notes', 'a.md'), 'utf8'), 'new a\n');
});

test('apply retiring through a symbolic link deletes the link, not its target', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  const outside = join(s.base, 'outside.md');
  writeFileSync(outside, 'outside original\n');
  rmSyncSync(s.live('notes', 'b.md'));
  symlinkSync(outside, s.live('notes', 'b.md'));
  s.work('notes', 'b.md', 'MOVED TO [[a]]\n');
  apply({ pairs: s.pairs, changes: [{ label: 'notes', file: 'b.md', kind: 'retire', target: { label: 'notes', file: 'a.md' } }] });
  assert.equal(readFileSync(outside, 'utf8'), 'outside original\n');
  assert.equal(existsSync(s.live('notes', 'b.md')), false);
});

test('apply refuses a retirement whose target is not present and deletes and writes nothing', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'a.md', 'edited\n');
  s.work('notes', 'b.md', 'MOVED TO [[nowhere]]\n');
  const changes = [
    { label: 'notes', file: 'a.md', kind: 'change' },
    { label: 'notes', file: 'b.md', kind: 'retire', target: { label: 'notes', file: 'nowhere.md' } },
  ];
  assert.throws(() => apply({ pairs: s.pairs, changes }));
  assert.equal(readFileSync(s.live('notes', 'b.md'), 'utf8'), 'note b\n');
  assert.equal(readFileSync(s.live('notes', 'a.md'), 'utf8'), 'note a\n');
});

test('apply refuses a retire change whose work file is not a stub', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  const changes = [{ label: 'notes', file: 'b.md', kind: 'retire', target: { label: 'notes', file: 'a.md' } }];
  assert.throws(() => apply({ pairs: s.pairs, changes }));
  assert.equal(existsSync(s.live('notes', 'b.md')), true);
});

test('apply refuses names that are not note files and unknown folders', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  for (const file of ['../x.md', 'sub/x.md', 'x.txt', '.hidden.md']) {
    assert.throws(() => apply({ pairs: s.pairs, changes: [{ label: 'notes', file, kind: 'add' }] }), undefined, file);
  }
  assert.throws(() => apply({ pairs: s.pairs, changes: [{ label: 'other', file: 'a.md', kind: 'add' }] }));
  assert.throws(() => apply({ pairs: s.pairs, changes: [{ label: 'notes', file: 'a.md', kind: 'delete' }] }));
});

test('snapshot refuses a work folder that already holds files', (t) => {
  const base = tempDir(t);
  write(join(base, 'work'), { 'stale.md': 'stale' });
  assert.throws(() => snapshot([{ label: 'notes', liveDir: join(base, 'live'), workDir: join(base, 'work') }]));
});
