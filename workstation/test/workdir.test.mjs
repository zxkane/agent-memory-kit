import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, lstatSync, rmSync as rmSyncSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply, evaluate, liveDiffers, noteTokens, snapshot } from '../lib/workdir.mjs';
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
    readLive: (label, file) => readFileSync(join(dirOf(label).liveDir, file), 'utf8'),
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
  assert.deepEqual(r.liveChanged, []);
  assert.deepEqual(r.stats.notes, {
    indexBefore: { lines: 2, bytes: Buffer.byteLength(INDEX_AB) },
    indexAfter: { lines: 2, bytes: Buffer.byteLength(INDEX_AB) },
    unlistedBefore: 0,
    unlistedAfter: 0,
    notesBytesBefore: 14,
    notesBytesAfter: 14,
    retiredBytes: 0,
  });
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
  const newIndex = '- [A](a.md) — a longer hook for a\n- [C](c.md) — c\n- [D](a.md) — again\n';
  s.work('notes', 'MEMORY.md', newIndex);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  const byFile = Object.fromEntries(r.changes.map((c) => [c.file, c]));
  assert.equal(byFile['a.md'].kind, 'change');
  assert.equal(byFile['a.md'].hash, sha('note a changed\n'));
  assert.equal(byFile['c.md'].kind, 'add');
  assert.equal(byFile['c.md'].hash, sha('new note c\n'));
  assert.equal(byFile['MEMORY.md'].kind, 'change');
  assert.deepEqual(byFile['b.md'], {
    label: 'notes', file: 'b.md', kind: 'retire', hash: sha('note b\n'), target: { label: 'notes', file: 'c.md' },
  });
  assert.equal(r.changes.length, 4);
  assert.deepEqual(r.stats.notes.indexBefore, { lines: 2, bytes: Buffer.byteLength(INDEX_AB) });
  assert.deepEqual(r.stats.notes.indexAfter, { lines: 3, bytes: Buffer.byteLength(newIndex) });
  assert.notEqual(r.stats.notes.indexAfter.bytes, r.stats.notes.indexBefore.bytes);
  assert.equal(r.stats.notes.unlistedBefore, 0);
  assert.equal(r.stats.notes.unlistedAfter, 0);
  assert.equal(r.stats.notes.notesBytesBefore, 14);
  assert.equal(r.stats.notes.notesBytesAfter, Buffer.byteLength('note a changed\nnew note c\n'));
  assert.equal(r.stats.notes.retiredBytes, 7);
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
    assert.ok(r.errors.some((e) => e.startsWith(`notes/${name}:`) || e.startsWith(`notes/${JSON.stringify(name)}:`)), `missing error for ${name}: ${r.errors}`);
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
  assert.deepEqual(r.errors, ['notes/a.md: the target note is itself retired', 'notes/b.md: the target note is itself retired']);
});

test('rule 3: a stub naming an earlier stub that was unchanged is an error', (t) => {
  const s = setup(t, { notes: { ...BASE_NOTES, 'old.md': 'MOVED TO [[a]]\n' } });
  s.work('notes', 'b.md', 'MOVED TO [[old]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['notes/b.md: the target note is itself retired']);
});

test('rule 3: a stub naming itself is an error', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'b.md', 'MOVED TO [[b]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['notes/b.md: the note names itself as target']);
});

test('rule 3: a stub naming MEMORY is an error', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'b.md', 'MOVED TO [[MEMORY]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['notes/b.md: the target is the index']);
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
  apply({ pairs: s.pairs, changes: r.changes, snap: s.snap });
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
  apply({ pairs: s.pairs, changes: r.changes, snap: s.snap });
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
  apply({ pairs: s.pairs, changes: r.changes, snap: s.snap });
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
  apply({ pairs: s.pairs, changes: r.changes, snap: s.snap });
  assert.deepEqual(readdirSync(s.pairs[0].liveDir).sort(), ['MEMORY.md', 'n.md']);
});


// Changes as evaluate would hand them to apply, built by hand for the refusal tests.
const change = (s, label, file, kind, extra = {}) => ({
  label, file, kind, hash: kind === 'retire' ? s.snap[label][file] : sha(readFileSync(s.workPath(label, file))), ...extra,
});

test('apply refuses a change over a symbolic link at the destination and writes nothing through it', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  const outside = join(s.base, 'outside.md');
  writeFileSync(outside, 'outside original\n');
  rmSyncSync(s.live('notes', 'a.md'));
  symlinkSync(outside, s.live('notes', 'a.md'));
  s.work('notes', 'a.md', 'new a\n');
  assert.throws(() => apply({ pairs: s.pairs, changes: [change(s, 'notes', 'a.md', 'change')], snap: s.snap }), /notes\/a\.md/);
  assert.equal(readFileSync(outside, 'utf8'), 'outside original\n');
  assert.equal(lstatSync(s.live('notes', 'a.md')).isSymbolicLink(), true);
});

test('apply refuses an add over a symbolic link that appeared after the snapshot', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  const outside = join(s.base, 'outside.md');
  writeFileSync(outside, 'outside original\n');
  s.work('notes', 'n.md', 'new\n');
  symlinkSync(outside, s.live('notes', 'n.md'));
  assert.throws(() => apply({ pairs: s.pairs, changes: [change(s, 'notes', 'n.md', 'add')], snap: s.snap }), /notes\/n\.md/);
  assert.equal(readFileSync(outside, 'utf8'), 'outside original\n');
});

test('apply refuses a retirement of a live note replaced by a link, leaving the target alone', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  const outside = join(s.base, 'outside.md');
  writeFileSync(outside, 'outside original\n');
  rmSyncSync(s.live('notes', 'b.md'));
  symlinkSync(outside, s.live('notes', 'b.md'));
  s.work('notes', 'b.md', 'MOVED TO [[a]]\n');
  const changes = [change(s, 'notes', 'b.md', 'retire', { target: { label: 'notes', file: 'a.md' } })];
  assert.throws(() => apply({ pairs: s.pairs, changes, snap: s.snap }), /notes\/b\.md/);
  assert.equal(readFileSync(outside, 'utf8'), 'outside original\n');
});

test('apply refuses a retirement whose target is not present and deletes and writes nothing', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'a.md', 'edited\n');
  s.work('notes', 'b.md', 'MOVED TO [[nowhere]]\n');
  const changes = [
    change(s, 'notes', 'a.md', 'change'),
    change(s, 'notes', 'b.md', 'retire', { target: { label: 'notes', file: 'nowhere.md' } }),
  ];
  assert.throws(() => apply({ pairs: s.pairs, changes, snap: s.snap }), /retirement target is not present/);
  assert.equal(readFileSync(s.live('notes', 'b.md'), 'utf8'), 'note b\n');
  assert.equal(readFileSync(s.live('notes', 'a.md'), 'utf8'), 'note a\n');
});

test('apply refuses a retire change whose work file is not a stub', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  const changes = [change(s, 'notes', 'b.md', 'retire', { target: { label: 'notes', file: 'a.md' } })];
  assert.throws(() => apply({ pairs: s.pairs, changes, snap: s.snap }), /not a retirement stub/);
  assert.equal(existsSync(s.live('notes', 'b.md')), true);
});

test('apply refuses a retirement whose target is retired in the same change set', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'a.md', 'MOVED TO [[b]]\n');
  s.work('notes', 'b.md', 'MOVED TO [[a]]\n');
  const changes = [
    change(s, 'notes', 'a.md', 'retire', { target: { label: 'notes', file: 'b.md' } }),
    change(s, 'notes', 'b.md', 'retire', { target: { label: 'notes', file: 'a.md' } }),
  ];
  assert.throws(() => apply({ pairs: s.pairs, changes, snap: s.snap }), /itself retired/);
  assert.equal(existsSync(s.live('notes', 'a.md')), true);
  assert.equal(existsSync(s.live('notes', 'b.md')), true);
});

test('apply refuses names that are not note files, unknown folders, kinds and missing hashes', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  const hash = sha('x');
  for (const file of ['../x.md', 'sub/x.md', 'x.txt', '.hidden.md']) {
    assert.throws(() => apply({ pairs: s.pairs, changes: [{ label: 'notes', file, kind: 'add', hash }], snap: s.snap }), undefined, file);
  }
  assert.throws(() => apply({ pairs: s.pairs, changes: [{ label: 'other', file: 'a.md', kind: 'add', hash }], snap: s.snap }));
  assert.throws(() => apply({ pairs: s.pairs, changes: [{ label: 'notes', file: 'a.md', kind: 'delete', hash }], snap: s.snap }));
  assert.throws(() => apply({ pairs: s.pairs, changes: [{ label: 'notes', file: 'a.md', kind: 'change' }], snap: s.snap }), /hash/);
  assert.throws(() => apply({ pairs: s.pairs, changes: [], snap: undefined }));
});

test('apply: a live note edited after the snapshot is not overwritten, even without liveDiffers', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'a.md', 'model edit\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, true);
  writeFileSync(s.live('notes', 'a.md'), 'session edit\n');
  assert.throws(() => apply({ pairs: s.pairs, changes: r.changes, snap: s.snap }), /notes\/a\.md: live file changed/);
  assert.equal(readFileSync(s.live('notes', 'a.md'), 'utf8'), 'session edit\n');
});

test('apply: a work file changed after evaluate (credential, oversize) is not written', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'a.md', 'model edit\n');
  s.work('notes', 'b.md', 'second edit\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, true);
  s.work('notes', 'b.md', `${FAKE_KEY}\n${'x'.repeat(200000)}`);
  assert.throws(() => apply({ pairs: s.pairs, changes: r.changes, snap: s.snap }), /notes\/b\.md: work file changed/);
  assert.equal(readFileSync(s.live('notes', 'a.md'), 'utf8'), 'note a\n');
  assert.equal(readFileSync(s.live('notes', 'b.md'), 'utf8'), 'note b\n');
});

test('apply: a live note that appeared under an add name after evaluate makes apply throw', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'c.md', 'model note\n');
  s.work('notes', 'MEMORY.md', `${INDEX_AB}- [C](c.md) — c\n`);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, true);
  writeFileSync(s.live('notes', 'c.md'), 'session note\n');
  assert.throws(() => apply({ pairs: s.pairs, changes: r.changes, snap: s.snap }), /notes\/c\.md: a live file appeared/);
  assert.equal(readFileSync(s.live('notes', 'c.md'), 'utf8'), 'session note\n');
  assert.equal(readFileSync(s.live('notes', 'MEMORY.md'), 'utf8'), INDEX_AB);
});

test('apply: a live note removed that a retirement names makes apply throw and changes nothing', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'b.md', 'MOVED TO [[a]]\n');
  s.work('notes', 'MEMORY.md', '- [A](a.md) — a\n');
  s.work('notes', 'a.md', 'a plus b\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, true);
  rmSyncSync(s.live('notes', 'b.md'));
  assert.throws(() => apply({ pairs: s.pairs, changes: r.changes, snap: s.snap }), /notes\/b\.md: live file changed/);
  assert.equal(readFileSync(s.live('notes', 'a.md'), 'utf8'), 'note a\n');
  assert.equal(readFileSync(s.live('notes', 'MEMORY.md'), 'utf8'), INDEX_AB);
});

test('apply: a destination that is a folder is refused before anything is written', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'a.md', 'edited\n');
  s.work('notes', 'z.md', 'new z\n');
  s.work('notes', 'MEMORY.md', `${INDEX_AB}- [Z](z.md) — z\n`);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, true);
  mkdirSync(s.live('notes', 'z.md'));
  assert.throws(() => apply({ pairs: s.pairs, changes: r.changes, snap: s.snap }), /notes\/z\.md/);
  assert.equal(readFileSync(s.live('notes', 'a.md'), 'utf8'), 'note a\n');
});

test('evaluate reports a live change in liveChanged, not in errors, and is not ok', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  writeFileSync(s.live('notes', 'a.md'), 'session edit\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.liveChanged, ['notes/a.md']);
});

test('rule 4: an unchanged empty index does not reject a run', (t) => {
  for (const index of ['', '  \n']) {
    const s = setup(t, { notes: { 'MEMORY.md': index, 'a.md': 'a\n' } });
    const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
  }
});

test('rule 6: an emptied note, a near-stub and an empty new note are errors', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'a.md', ' \n\n');
  s.work('notes', 'b.md', 'MOVED TO [[a]].\n');
  s.work('notes', 'MEMORY.md', `${INDEX_AB}- [N](n.md) — n\n`);
  s.work('notes', 'n.md', '');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.sort(), [
    'notes/a.md: a note may not be emptied; retire it instead',
    'notes/b.md: malformed retirement line',
    'notes/n.md: a note may not be emptied; retire it instead',
  ]);
});

test('rule 6: a malformed retirement line in a new note is an error', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'MEMORY.md', `${INDEX_AB}- [N](n.md) — n\n`);
  s.work('notes', 'n.md', 'MOVED TO [[a/b]]\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, ['notes/n.md: malformed retirement line']);
});

test('M-2: a work file name with a newline cannot forge a second error line', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  writeFileSync(join(s.pairs[0].workDir, 'x.md\nforged rule: x'), 'x');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.ok(!r.errors[0].includes('\n'));
  assert.ok(r.errors[0].startsWith('notes/"'));
});

test('M-3: a credential-shaped file name is an error and is not repeated in errors', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', `${FAKE_KEY}.md`, 'harmless\n');
  s.work('notes', 'MEMORY.md', `${INDEX_AB}- [K](${FAKE_KEY}.md) — k\n`);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  // The index line that names the file is flagged too, as content.
  assert.deepEqual(r.errors, [
    'notes/"(file name withheld)": file name looks like a credential',
    'notes/MEMORY.md: note contains text that looks like a credential',
  ]);
  assert.ok(!JSON.stringify(r.errors).includes(FAKE_KEY));
  assert.ok(!r.changes.some((c) => c.file.includes(FAKE_KEY)));
});

test('M-4: an unreadable work file is an error line, not a throw', (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root can read any file');
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'secret.md', 'x');
  chmodSync(s.workPath('notes', 'secret.md'), 0);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['notes/secret.md: not a regular note file']);
  return undefined;
});

test('M-5: snapshot copies nothing when a later work folder is unusable', (t) => {
  const base = tempDir(t);
  write(join(base, 'live1'), { 'a.md': 'a' });
  write(join(base, 'live2'), { 'b.md': 'b' });
  write(join(base, 'work2'), { 'stale.md': 'stale' });
  const pairs = [
    { label: 'notes', liveDir: join(base, 'live1'), workDir: join(base, 'work1') },
    { label: 'global', liveDir: join(base, 'live2'), workDir: join(base, 'work2') },
  ];
  assert.throws(() => snapshot(pairs));
  assert.equal(existsSync(join(base, 'work1')), false);
});

test('M-9: snapshot refuses a work folder that is a symbolic link', (t) => {
  const base = tempDir(t);
  mkdirSync(join(base, 'elsewhere'), { mode: 0o755 });
  symlinkSync(join(base, 'elsewhere'), join(base, 'work'));
  assert.throws(() => snapshot([{ label: 'notes', liveDir: join(base, 'live'), workDir: join(base, 'work') }]));
  assert.equal(statSync(join(base, 'elsewhere')).mode & 0o777, 0o755);
});

test('snapshot refuses a work folder that already holds files', (t) => {
  const base = tempDir(t);
  write(join(base, 'work'), { 'stale.md': 'stale' });
  assert.throws(() => snapshot([{ label: 'notes', liveDir: join(base, 'live'), workDir: join(base, 'work') }]));
});

// ---- round 2 ----

const terms = (prefix, from, to) => Array.from({ length: to - from }, (_, i) => `${prefix}${String(from + i).padStart(4, '0')}`).join(' ');

test('noteTokens: English, identifiers, short words, Han, mixed', () => {
  assert.deepEqual([...noteTokens('The Quick brown fox, jumps!')].sort(), ['brown', 'jumps', 'quick']);
  assert.deepEqual([...noteTokens('use MAX_RETRY_COUNT=5 and v2 api_key')].sort(), ['api_key', 'max_retry_count']);
  assert.deepEqual([...noteTokens('a an of to')], []);
  assert.deepEqual([...noteTokens('知识库管理')].sort(), ['库管', '知识', '管理', '识库']);
  assert.deepEqual([...noteTokens('的')], ['的']);
  assert.deepEqual([...noteTokens('deploy知识库 now')].sort(), ['deploy', '知识', '识库'].sort());
  assert.deepEqual([...noteTokens('Straße ÅNGSTRÖM')].sort(), ['straße', 'ångström']);
});

test('rule 7: stubs count on neither side', (t) => {
  const s = setup(t, { notes: { 'MEMORY.md': '- [A](a.md) — a\n', 'a.md': 'alpha beta gamma\n', 'old.md': 'MOVED TO [[a]]\n' } });
  s.work('notes', 'a.md', 'alpha beta gamma delta\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.stats.notes.notesBytesBefore, Buffer.byteLength('alpha beta gamma\n'));
  assert.equal(r.stats.notes.notesBytesAfter, Buffer.byteLength('alpha beta gamma delta\n'));
});

test('rule 6: tolerant forms of a retirement line are errors', (t) => {
  const forms = ['Moved to [[a]]', 'MOVED  TO [[a]]', 'MOVED TO [[a]]', 'MOVED TO [ [a]]', 'moved to[[a]]'];
  for (const form of forms) {
    const s = setup(t, { notes: BASE_NOTES });
    s.work('notes', 'b.md', `${form}\n`);
    const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
    assert.deepEqual(r.errors, ['notes/b.md: malformed retirement line'], JSON.stringify(form));
  }
});

test('rule 6: an exact stub is still a retirement, and ordinary prose starting with "Moved to" is fine', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'b.md', 'MOVED TO [[a]]\n');
  s.work('notes', 'MEMORY.md', '- [A](a.md) — a\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  assert.ok(r.changes.some((c) => c.kind === 'retire'));
  const p = setup(t, { notes: BASE_NOTES });
  p.work('notes', 'a.md', 'Moved to the new cluster in March\n');
  assert.deepEqual(evaluate({ pairs: p.pairs, snap: p.snap, allowRetire: true }).errors, []);
});

test('S1: a changed note keeps its mode, a new note is 0600, whatever the umask', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  chmodSync(s.live('notes', 'a.md'), 0o600);
  chmodSync(s.live('notes', 'b.md'), 0o644);
  s.work('notes', 'a.md', 'a edited\n');
  s.work('notes', 'b.md', 'b edited\n');
  s.work('notes', 'c.md', 'c new\n');
  s.work('notes', 'MEMORY.md', `${INDEX_AB}- [C](c.md) — c\n`);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  const old = process.umask(0);
  try {
    apply({ pairs: s.pairs, changes: r.changes, snap: s.snap });
  } finally {
    process.umask(old);
  }
  const mode = (f) => statSync(s.live('notes', f)).mode & 0o777;
  assert.equal(mode('a.md'), 0o600);
  assert.equal(mode('b.md'), 0o644);
  assert.equal(mode('c.md'), 0o600);
});

test('N3: a link or a folder at the name of an added note is a live change', (t) => {
  for (const kind of ['link', 'folder']) {
    const s = setup(t, { notes: BASE_NOTES });
    s.work('notes', 'n.md', 'new\n');
    s.work('notes', 'MEMORY.md', `${INDEX_AB}- [N](n.md) — n\n`);
    if (kind === 'link') symlinkSync(join(s.base, 'nowhere'), s.live('notes', 'n.md'));
    else mkdirSync(s.live('notes', 'n.md'));
    const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
    assert.equal(r.ok, false, kind);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.liveChanged, ['notes/n.md']);
  }
});

test('N3: liveDiffers lists a snapshot note that became a link or a folder, and watched names', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  rmSyncSync(s.live('notes', 'a.md'));
  symlinkSync(join(s.base, 'nowhere'), s.live('notes', 'a.md'));
  rmSyncSync(s.live('notes', 'b.md'));
  mkdirSync(s.live('notes', 'b.md'));
  mkdirSync(s.live('notes', 'w.md'));
  assert.deepEqual(liveDiffers(s.pairs, s.snap).sort(), ['notes/a.md', 'notes/b.md']);
  assert.deepEqual(liveDiffers(s.pairs, s.snap, ['notes/w.md']).sort(), ['notes/a.md', 'notes/b.md', 'notes/w.md']);
});

test('N4: a credential-shaped name that is not a note name is withheld from errors', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  writeFileSync(join(s.pairs[0].workDir, `${FAKE_KEY}.txt`), 'x');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, ['notes/"(file name withheld)": not a regular note file']);
  assert.ok(!JSON.stringify(r).includes(FAKE_KEY));
});

test('N2: apply refuses a retire change whose target is not the one the stub names', (t) => {
  const s = setup(t, { notes: { ...BASE_NOTES, 'c.md': 'note c\n' } });
  s.work('notes', 'b.md', 'MOVED TO [[a]]\n');
  const forged = [change(s, 'notes', 'b.md', 'retire', { target: { label: 'notes', file: 'c.md' } })];
  assert.throws(() => apply({ pairs: s.pairs, changes: forged, snap: s.snap }), /notes\/b\.md: retirement target is not the one the stub names/);
  assert.equal(existsSync(s.live('notes', 'b.md')), true);
  const honest = [change(s, 'notes', 'b.md', 'retire', { target: { label: 'notes', file: 'a.md' } })];
  apply({ pairs: s.pairs, changes: honest, snap: s.snap });
  assert.equal(existsSync(s.live('notes', 'b.md')), false);
});

// ---- round 3 ----

const MISSING = /^notes\/(n\d)\.md: most of this note's content is missing after the run \(kept (\d+)% of its distinct terms, at least 25% required\)$/;

// Ten notes of 60 distinct terms each, every one with terms of its own.
function tenNotes(t) {
  const notes = { 'MEMORY.md': Array.from({ length: 10 }, (_, i) => `- [N${i}](n${i}.md) — n${i}\n`).join('') };
  for (let i = 0; i < 10; i++) notes[`n${i}.md`] = `${terms(`note${i}x`, 0, 60)}\n`;
  return setup(t, { notes });
}

const indexWithout = (...gone) => Array.from({ length: 10 }, (_, i) => i).filter((i) => !gone.includes(i))
  .map((i) => `- [N${i}](n${i}.md) — n${i}\n`).join('');

test('noteTokens: NFKC and a separate combining accent give one term', () => {
  assert.deepEqual([...noteTokens('naïve café')].sort(), ['café', 'naïve']);
  assert.deepEqual(noteTokens('naïve'), noteTokens('naïve'));
});

test('rule 7: a note retired into an unrelated note is reported by name', (t) => {
  const s = tenNotes(t);
  s.work('notes', 'n3.md', 'MOVED TO [[n7]]\n');
  s.work('notes', 'MEMORY.md', indexWithout(3));
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2, 'the note, and the run (60 terms touched)');
  assert.match(r.errors[0], MISSING);
  assert.match(r.errors[1], RUN_ERROR);
  assert.equal(r.errors[0].startsWith('notes/n3.md: '), true);
  assert.deepEqual(r.stats.retention, { termsBefore: 60, termsKept: 0, share: 0, checked: 1, lowest: 0 });
});

test('rule 7: the same retirement into a target that holds its content passes (share 1)', (t) => {
  const s = tenNotes(t);
  s.work('notes', 'n3.md', 'MOVED TO [[n7]]\n');
  s.work('notes', 'n7.md', `${terms('note7x', 0, 60)} ${terms('note3x', 0, 60)}\n`);
  s.work('notes', 'MEMORY.md', indexWithout(3));
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.stats.retention, { termsBefore: 120, termsKept: 120, share: 1, checked: 2, lowest: 1 });
});

const DEPLOY = 'The staging deployment runs on cluster kestrel_stage in region eu-west-1. Release trains leave every Tuesday '
  + 'through pipeline build_and_ship. Rollbacks use the script rollback_release.sh with the flag --previous. '
  + 'The artifact bucket is acme_artifacts_stage and the retention window is 365 days. Pager rotation lives in '
  + 'schedule oncall_platform and escalates to the lead engineer Marguerite Okafor. Always announce releases beforehand, watch dashboards afterwards, '
  + 'and write a short summary for colleagues.\n';
const BILLING = 'Invoices are produced by the job invoice_batch_nightly against database ledger_primary on port 5433. '
  + 'Customers in tier enterprise_plus receive net60 terms, everybody else net30. Refund approvals above 2500 euros '
  + 'need a second reviewer from the group finance_ops, tracked in queue refunds_pending by Tobias Lindqvist. Month closing happens quietly, so remember reconciling '
  + 'statements before reports leave the building.\n';
const SEARCH = 'The search service reads index catalog_v7 from cluster opensearch_eu using the alias catalog_live. '
  + 'Reindexing runs through the task reindex_catalog with batch size 2000 and finishes in roughly forty minutes. '
  + 'Synonym lists are stored in repository synonyms_repo, maintained by Priya Raghunathan. Relevance complaints usually come from stale synonyms, therefore check those '
  + 'before touching ranking weights.\n';
const MERGED = 'Operations facts. Deploys: cluster kestrel_stage, eu-west-1, pipeline build_and_ship, tuesday trains, '
  + 'script rollback_release.sh (--previous), bucket acme_artifacts_stage kept 365 days, schedule oncall_platform, '
  + 'contact Marguerite Okafor. Billing: job invoice_batch_nightly, database ledger_primary port 5433, tier '
  + 'enterprise_plus gets net60 else net30, refunds over 2500 go to finance_ops via refunds_pending, owner Tobias '
  + 'Lindqvist. Search: index catalog_v7 on opensearch_eu, alias catalog_live, task reindex_catalog (batch 2000), '
  + 'synonyms in synonyms_repo, owner Priya Raghunathan.\n';

test('rule 7: three notes merged into a topic note that keeps their facts, reworded, pass at the default', (t) => {
  const s = setup(t, { notes: { 'MEMORY.md': '- [D](deploy.md) — d\n- [B](billing.md) — b\n- [S](search.md) — s\n', 'deploy.md': DEPLOY, 'billing.md': BILLING, 'search.md': SEARCH } });
  s.work('notes', 'ops.md', MERGED);
  for (const n of ['deploy', 'billing', 'search']) s.work('notes', `${n}.md`, 'MOVED TO [[ops]]\n');
  s.work('notes', 'MEMORY.md', '- [O](ops.md) — o\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.retention.checked, 3);
  assert.ok(r.stats.retention.lowest >= 0.3 && r.stats.retention.lowest < 1, String(r.stats.retention.lowest));
});

test('rule 7: ten notes retired into one short summary give an error for each note', (t) => {
  const s = tenNotes(t);
  for (let i = 1; i < 10; i++) s.work('notes', `n${i}.md`, 'MOVED TO [[n0]]\n');
  s.work('notes', 'n0.md', `${terms('note0x', 0, 10)}\n`);
  s.work('notes', 'MEMORY.md', indexWithout(1, 2, 3, 4, 5, 6, 7, 8, 9));
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  // Ten per-note errors, plus the run-level one (600 terms, 10 kept).
  assert.equal(r.errors.length, 11);
  const perNote = r.errors.filter((e) => e.startsWith("notes/"));
  for (const e of perNote) assert.match(e, MISSING);
  assert.deepEqual(perNote.map((e) => MISSING.exec(e)[1]).sort(), ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9"]);
  assert.equal(r.errors.filter((e) => !e.startsWith("notes/")).length, 1);
  assert.equal(r.stats.retention.checked, 10);
  assert.equal(r.stats.retention.lowest, 0);
  assert.equal(r.stats.retention.termsKept, 10);
  assert.equal(r.stats.retention.termsBefore, 600);
  const off = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true, minRetention: 0 });
  assert.deepEqual(off.errors, []);
  assert.equal(off.ok, true);
});

test('rule 7: a note tightened by dropping every third word passes (share 40/60)', (t) => {
  const s = setup(t, { notes: { 'MEMORY.md': '- [A](a.md) — a\n', 'a.md': `${terms('tigh', 0, 60)}\n` } });
  s.work('notes', 'a.md', `${terms('tigh', 0, 60).split(' ').filter((_, i) => i % 3 !== 2).join(' ')}\n`);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.stats.retention, { termsBefore: 60, termsKept: 40, share: 40 / 60, checked: 1, lowest: 40 / 60 });
});

test('rule 7: half of a note moved into a new note written in the same run passes (share 1)', (t) => {
  const s = setup(t, { notes: { 'MEMORY.md': '- [A](a.md) — a\n', 'a.md': `${terms('half', 0, 60)}\n` } });
  s.work('notes', 'a.md', `${terms('half', 0, 30)}\n`);
  s.work('notes', 'b.md', `${terms('half', 30, 60)}\n`);
  s.work('notes', 'MEMORY.md', '- [A](a.md) — a\n- [B](b.md) — b\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.retention.share, 1);
});

test('rule 7: a short note (under 15 terms) gutted is not judged', (t) => {
  const s = setup(t, { notes: { 'MEMORY.md': '- [A](a.md) — a\n', 'a.md': `${terms('shrt', 0, 14)}\n` } });
  s.work('notes', 'a.md', 'something else entirely\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.stats.retention, { termsBefore: 14, termsKept: 0, share: 0, checked: 0, lowest: null });
});

test('rule 7: padding with an unrelated filler note does not hide a gutted note', (t) => {
  const s = setup(t, { notes: { 'MEMORY.md': '- [A](a.md) — a\n', 'a.md': `${terms('real', 0, 60)}\n` } });
  s.work('notes', 'a.md', 'short\n');
  s.work('notes', 'filler.md', `${terms('fill', 0, 500)}\n`);
  s.work('notes', 'MEMORY.md', '- [A](a.md) — a\n- [F](filler.md) — f\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /^notes\/a\.md: most of this note's content is missing after the run \(kept 0% /);
  assert.match(r.errors[1], RUN_ERROR);
});

test('rule 7: no change leaves stats.retention neutral', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.stats.retention, { termsBefore: 0, termsKept: 0, share: 1, checked: 0, lowest: null });
});

test('rule 6: a stub behind frontmatter, behind a zero-width space, or a note cut to its frontmatter is an error', (t) => {
  const withFront = '---\nname: a\ndescription: x\n---\nnote a\n';
  const cases = [
    ['---\nname: b\n---\nMOVED TO [[a]]\n', 'b.md', 'malformed retirement line'],
    ['​MOVED TO [[a]]\n', 'b.md', 'malformed retirement line'],
    ['﻿​---\nname: b\n---\nMoved to [[a]]\n', 'b.md', 'malformed retirement line'],
    ['---\nname: a\ndescription: x\n---\n', 'a.md', 'a note may not be emptied; retire it instead'],
  ];
  for (const [content, file, problem] of cases) {
    const s = setup(t, { notes: { ...BASE_NOTES, 'a.md': withFront } });
    s.work('notes', file, content);
    const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
    assert.deepEqual(r.errors, [`notes/${file}: ${problem}`], JSON.stringify(content));
  }
});

test('rule 6: prose that begins "Moved to [staging](url)" is accepted', (t) => {
  const s = setup(t, { notes: BASE_NOTES });
  s.work('notes', 'a.md', 'Moved to [staging](https://example.com) last week.\n');
  assert.deepEqual(evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true }).errors, []);
});

test('rule 6: a note that already had only frontmatter may be changed to other frontmatter', (t) => {
  const s = setup(t, { notes: { ...BASE_NOTES, 'a.md': '---\nname: a\n---\n' } });
  s.work('notes', 'a.md', '---\nname: a\ndescription: y\n---\n');
  assert.deepEqual(evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true }).errors, []);
});

test('live folder missing at snapshot time but now a plain file is reported by liveDiffers', (t) => {
  const s = setup(t, { notes: {} });
  rmSyncSync(s.pairs[0].liveDir, { recursive: true });
  writeFileSync(s.pairs[0].liveDir, 'in the way');
  assert.deepEqual(liveDiffers(s.pairs, s.snap), ['notes/']);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.deepEqual(r.liveChanged, ['notes/']);
});

// ---- round 4 ----

function shortNotes(t, count, extra = {}, size = 20) {
  const notes = { 'MEMORY.md': Array.from({ length: count }, (_, i) => `- [S${i}](s${i}.md) — s${i}\n`).join(''), ...extra };
  for (let i = 0; i < count; i++) notes[`s${i}.md`] = `${terms(`sh${String(i).padStart(2, '0')}x`, 0, size)}\n`;
  return setup(t, { notes });
}

const RUN_ERROR = /^the run would drop too much of the touched notes' content \(kept \d+% of their distinct terms, at least 25% required\)$/;

test('run level: thirty short notes gutted give one run-level error and no per-note error', (t) => {
  const s = shortNotes(t, 30, {}, 12);
  for (let i = 0; i < 30; i++) s.work('notes', `s${i}.md`, 'two words\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], RUN_ERROR);
  assert.match(r.errors[0], /kept 0% /);
  assert.equal(r.stats.retention.checked, 0);
  assert.equal(r.stats.retention.termsBefore, 360);
  const off = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true, minRetention: 0 });
  assert.deepEqual(off.errors, []);
});

test('run level: four short notes of 14 terms gutted (under 60 terms in total) pass', (t) => {
  const s = shortNotes(t, 4, {}, 14);
  for (let i = 0; i < 4; i++) s.work('notes', `s${i}.md`, 'two words\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.retention.termsBefore, 56);
});

test('run level: one long note honestly tightened beside untouched short notes passes', (t) => {
  const s = shortNotes(t, 10, { 'long.md': `${terms('long', 0, 240)}\n` });
  s.work('notes', 'long.md', `${terms('long', 0, 240).split(' ').filter((_, i) => i % 3 !== 2).join(' ')}\n`);
  s.work('notes', 'MEMORY.md', `${s.readLive('notes', 'MEMORY.md')}- [L](long.md) — l\n`);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.retention.termsBefore, 240);
});

// ---- round 5 ----

const front = (description, extra = '') => `---\nname: x\ndescription: ${description}\nmetadata:\n  type: project\n${extra}---\n`;
const PER_NOTE = (file) => new RegExp(`^notes/${file.replace('.', '\\.')}: most of this note's content is missing after the run \\(kept (\\d+)% of its distinct terms, at least 25% required\\)$`);

test('rule 7 counts the body only: a rich description does not keep a gutted body', (t) => {
  const s = setup(t, { notes: { 'MEMORY.md': '- [A](a.md) — a\n', 'a.md': `${front(terms('desc', 0, 30))}${terms('body', 0, 30)}\n` } });
  s.work('notes', 'a.md', `${front(terms('desc', 0, 30))}one line only\n`);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], PER_NOTE('a.md'));
  assert.deepEqual(r.stats.retention, { termsBefore: 30, termsKept: 0, share: 0, checked: 1, lowest: 0 });
});

test('rule 7: a frontmatter-only change on a note with an untouched body has share 1', (t) => {
  const s = setup(t, { notes: { 'MEMORY.md': '- [A](a.md) — a\n', 'a.md': `${front('old words')}${terms('body', 0, 30)}\n` } });
  s.work('notes', 'a.md', `${front('a repaired and much better description', 'type: reference\n')}${terms('body', 0, 30)}\n`);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.stats.retention, { termsBefore: 30, termsKept: 30, share: 1, checked: 1, lowest: 1 });
});

test('rule 7: one note gutted while three others get a one-word edit is still an error', (t) => {
  const s = tenNotes(t);
  s.work('notes', 'n0.md', 'tiny\n');
  for (const i of [1, 2, 3]) s.work('notes', `n${i}.md`, `${terms(`note${i}x`, 0, 60)} extraword\n`);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], PER_NOTE('n0.md'));
  assert.equal(r.stats.retention.lowest, 0);
  assert.equal(r.stats.retention.checked, 4);
});

test('rule 7: terms that another changed note already had do not count as kept', (t) => {
  const shared = terms('sharx', 0, 40);
  const s = setup(t, { notes: { 'MEMORY.md': '- [A](a.md) — a\n- [B](b.md) — b\n', 'a.md': `${shared}\n`, 'b.md': `${shared} ${terms('bonly', 0, 40)}\n` } });
  s.work('notes', 'a.md', 'tiny\n');
  s.work('notes', 'b.md', `${shared} ${terms('bonly', 0, 40)} extraword\n`);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], PER_NOTE('a.md'));
});

test('rule 7: content moved into an existing note that did not have those terms passes', (t) => {
  const s = setup(t, { notes: { 'MEMORY.md': '- [A](a.md) — a\n- [B](b.md) — b\n', 'a.md': `${terms('mvdx', 0, 60)}\n`, 'b.md': `${terms('othr', 0, 60)}\n` } });
  s.work('notes', 'a.md', `${terms('mvdx', 0, 30)}\n`);
  s.work('notes', 'b.md', `${terms('othr', 0, 60)} ${terms('mvdx', 30, 60)}\n`);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.retention.lowest, 1);
});

test('rule 7: eight short notes (12 terms) gutted give the run-level error only; three of 16 terms give per-note errors', (t) => {
  const eight = shortNotes(t, 8, {}, 12);
  for (let i = 0; i < 8; i++) eight.work('notes', `s${i}.md`, 'two words\n');
  const r = evaluate({ pairs: eight.pairs, snap: eight.snap, allowRetire: true });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], RUN_ERROR);
  assert.equal(r.stats.retention.termsBefore, 96);
  assert.equal(r.stats.retention.checked, 0);
  const three = shortNotes(t, 3, {}, 16);
  for (let i = 0; i < 3; i++) three.work('notes', `s${i}.md`, 'two words\n');
  const q = evaluate({ pairs: three.pairs, snap: three.snap, allowRetire: true });
  assert.equal(q.errors.length, 3);
  for (let i = 0; i < 3; i++) assert.match(q.errors[i], PER_NOTE(`s${i}.md`));
  assert.equal(q.stats.retention.termsBefore, 48);
});

test('rule 7: a single note of 14 body terms gutted is not judged', (t) => {
  const s = setup(t, { notes: { 'MEMORY.md': '- [A](a.md) — a\n', 'a.md': `${front('d')}${terms('tiny', 0, 14)}\n` } });
  s.work('notes', 'a.md', `${front('d')}gone\n`);
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.stats.retention, { termsBefore: 14, termsKept: 0, share: 0, checked: 0, lowest: null });
});

test('rule 7: the default is 0.25', (t) => {
  const s = setup(t, { notes: { 'MEMORY.md': '- [A](a.md) — a\n', 'a.md': `${terms('dflt', 0, 40)}\n` } });
  s.work('notes', 'a.md', `${terms('dflt', 0, 9)}\n`);
  assert.equal(evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true }).ok, false);
  s.work('notes', 'a.md', `${terms('dflt', 0, 10)}\n`);
  assert.equal(evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true }).ok, true);
  assert.equal(evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true, minRetention: 0.3 }).ok, false);
});

test('rule 6: whole-body retirement lines only; prose that goes on is not rule 6', (t) => {
  const reject = ['MOVED TO [[a]].', 'moved to [ [a] ]', 'MOVED \u200bTO [[a]]', 'MO\u200bVED TO [[a]]', 'MOVED\u00a0TO [[a]]', '\n\u200bMOVED TO [[a]]'];
  for (const form of reject) {
    const s = setup(t, { notes: BASE_NOTES });
    s.work('notes', 'b.md', `${form}\n`);
    const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
    assert.deepEqual(r.errors, ['notes/b.md: malformed retirement line'], JSON.stringify(form));
  }
  const prose = setup(t, { notes: BASE_NOTES });
  prose.work('notes', 'b.md', 'Moved to [[a]] the deploy section; the rest stays here.\n');
  assert.deepEqual(evaluate({ pairs: prose.pairs, snap: prose.snap, allowRetire: true }).errors, []);
});

test('rule 6: a stub plus a few words over a rich note is a rule 7 error, not rule 6', (t) => {
  const s = setup(t, { notes: { 'MEMORY.md': '- [A](a.md) — a\n- [B](b.md) — b\n', 'a.md': 'note a\n', 'b.md': `${terms('seeb', 0, 30)}\n` } });
  s.work('notes', 'b.md', 'MOVED TO [[a]] see there\n');
  const r = evaluate({ pairs: s.pairs, snap: s.snap, allowRetire: true });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], PER_NOTE('b.md'));
});
