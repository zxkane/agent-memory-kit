import assert from 'node:assert/strict';
import test from 'node:test';
import { INDEX, NOTE_NAME_RE, parseNote, indexRefs, stubTarget, indexStats } from '../lib/notes.mjs';

const NOTE = [
  '---',
  'name: deploy-region',
  'description: "deploys go to region one, since March 2026"',
  'metadata:',
  '  node_type: memory',
  '  type: project',
  '---',
  '',
  'Body text.',
  '',
].join('\n');

test('constants', () => {
  assert.equal(INDEX, 'MEMORY.md');
  assert.ok(NOTE_NAME_RE.test('a-b_c.1.md'));
  assert.ok(!NOTE_NAME_RE.test('sub/x.md'));
  assert.ok(!NOTE_NAME_RE.test('.hidden.md'));
});

test('parseNote reads a normal note', () => {
  assert.deepEqual(parseNote(NOTE), {
    name: 'deploy-region', description: 'deploys go to region one, since March 2026', type: 'project',
  });
});

test('parseNote removes single quotes and handles unquoted values', () => {
  const t = "---\nname: x\ndescription: 'it is quoted'\n---\n";
  assert.deepEqual(parseNote(t), { name: 'x', description: 'it is quoted', type: null });
  assert.equal(parseNote('---\ndescription: plain words\n---\n').description, 'plain words');
});

test('parseNote takes type only from under metadata', () => {
  assert.equal(parseNote('---\nname: x\ntype: user\n---\n').type, null);
  assert.equal(parseNote('---\nname: x\ntype: user\nmetadata:\n  type: feedback\n---\n').type, 'feedback');
});

test('parseNote without frontmatter or with an unclosed block gives nulls', () => {
  const nulls = { name: null, description: null, type: null };
  assert.deepEqual(parseNote('Just text\nname: x\n'), nulls);
  assert.deepEqual(parseNote('---\nname: x\ndescription: y\n'), nulls);
  assert.deepEqual(parseNote(''), nulls);
});

test('parseNote handles CRLF line endings', () => {
  assert.deepEqual(parseNote(NOTE.replaceAll('\n', '\r\n')), {
    name: 'deploy-region', description: 'deploys go to region one, since March 2026', type: 'project',
  });
});

test('indexRefs lists note files once and skips paths and URLs', () => {
  const idx = [
    '- [A](a.md) — first',
    '- [B](b-note.md) — second',
    '- [Sub](sub/x.md) — nested',
    '- [Web](https://example.com/a.md) — url',
    '- [A again](a.md) — repeat',
  ].join('\n');
  assert.deepEqual([...indexRefs(idx)].sort(), ['a.md', 'b-note.md']);
});

test('stubTarget accepts both forms', () => {
  assert.deepEqual(stubTarget('MOVED TO [[deploy-region]]'), { folder: 'same', name: 'deploy-region' });
  assert.deepEqual(stubTarget('MOVED TO [[global:deploy-region]]'), { folder: 'global', name: 'deploy-region' });
  assert.deepEqual(stubTarget('  \nMOVED TO [[x.y]]\n\n'), { folder: 'same', name: 'x.y' });
});

test('stubTarget rejects other text', () => {
  for (const t of [
    'MOVED TO [[a]] and more', 'MOVED TO [[a]]\nsecond line', 'MOVED TO [[a/b]]',
    'MOVED TO [[../x]]', 'MOVED TO [[]]', 'MOVED TO [[global:]]', 'moved to [[a]]', '', 'MOVED TO [[a]',
  ]) assert.equal(stubTarget(t), null, t);
});

test('indexStats counts lines and UTF-8 bytes', () => {
  assert.deepEqual(indexStats(''), { lines: 0, bytes: 0 });
  assert.deepEqual(indexStats('a\nb\n'), { lines: 2, bytes: 4 });
  assert.deepEqual(indexStats('a\nb'), { lines: 2, bytes: 3 });
  assert.deepEqual(indexStats('日本語'), { lines: 1, bytes: 9 });
});
