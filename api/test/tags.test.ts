import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tagIndexText } from '../src/tags.ts';
import { DOMAINS, type Domain } from '../src/snapshot.ts';
import { LABELS } from '../../workstation/lib/domains.mjs';

const tag = (text: string, domain: Domain) => tagIndexText(text, new Map([['a.md', domain]]));

test('tagIndexText inserts the tag after the first em dash of a work or personal note', () => {
  assert.equal(tag('- [A](a.md) — about a', 'work'), '- [A](a.md) — [work] about a');
  assert.equal(tag('- [A](a.md) — about a — more', 'personal'), '- [A](a.md) — [personal] about a — more');
});

test('tagIndexText leaves other lines and general notes unchanged', () => {
  for (const line of [
    '- [A](a.md) about a',
    '- [A](../x/a.md) — about a',
    '# Heading',
    '',
  ]) {
    assert.equal(tag(line, 'work'), line, line);
  }
  assert.equal(tag('- [A](a.md) — about a', 'general'), '- [A](a.md) — about a');
  assert.equal(tagIndexText('- [B](b.md) — about b', new Map([['a.md', 'work']])), '- [B](b.md) — about b');
});

test('tagIndexText keeps line endings and tags each line on its own', () => {
  const map = new Map<string, Domain>([['a.md', 'work'], ['b.md', 'personal']]);
  assert.equal(
    tagIndexText('# T\r\n- [A](a.md) — x\r\n- [B](b.md) — y\n', map),
    '# T\r\n- [A](a.md) — [work] x\r\n- [B](b.md) — [personal] y\n',
  );
});

test('DOMAINS equals the labels of the workstation', () => {
  assert.deepEqual([...DOMAINS], [...LABELS]);
});

test('tagIndexText takes the tag only from the note', () => {
  assert.equal(tag('- [A](a.md) — [work] about a', 'work'), '- [A](a.md) — [work] about a');
  assert.equal(tag('- [A](a.md) — [work] about a', 'personal'), '- [A](a.md) — [personal] about a');
  assert.equal(tag('- [A](a.md) — [work] about a', 'general'), '- [A](a.md) — about a');
  assert.equal(tag('- [A](a.md) — [personal] [work] about a', 'work'), '- [A](a.md) — [work] about a');
  assert.equal(tagIndexText('- [B](b.md) — [work] about b', new Map()), '- [B](b.md) — about b');
  assert.equal(tag('- [A](../x/a.md) — [work] about a', 'personal'), '- [A](../x/a.md) — [work] about a');
  const once = tag('- [A](a.md) — about a', 'work');
  assert.equal(tag(once, 'work'), once);
});
