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

test('tagIndexText also strips a tag token at the end of the line or before a tab', () => {
  assert.equal(tag('- [A](a.md) — [work]', 'general'), '- [A](a.md) — ');
  assert.equal(tag('- [A](a.md) — [work]', 'personal'), '- [A](a.md) — [personal] ');
  assert.equal(tag('- [A](a.md) — [personal]\r', 'general'), '- [A](a.md) — \r');
  assert.equal(tagIndexText('- [B](b.md) — [personal]\r\n', new Map()), '- [B](b.md) — \r\n');
  // The white space right after the run goes with it; a line end stays.
  assert.equal(tag('- [A](a.md) — [work]\tabout a', 'general'), '- [A](a.md) — about a');
  assert.equal(tag('- [A](a.md) — [work]\tabout a', 'personal'), '- [A](a.md) — [personal] about a');
  assert.equal(tag('- [A](a.md) — about [work]', 'general'), '- [A](a.md) — about [work]');
  for (const line of ['- [A](a.md) — [work]', '- [A](a.md) — [personal]\r', '- [A](a.md) — [work]\tx']) {
    const once = tag(line, 'work');
    assert.equal(tag(once, 'work'), once);
  }
});

test('tagIndexText drops the gap at the start of a hook it tags, so tagging again gives the same line', () => {
  // Spaces, a tab or a format character before the hook, without a tag.
  for (const gap of ['  ', '\t', '\u200b']) {
    const line = `- [A](a.md) — ${gap}about`;
    for (const domain of ['work', 'personal'] as const) {
      const once = tag(line, domain);
      assert.equal(once, `- [A](a.md) — [${domain}] about`, JSON.stringify(gap));
      assert.equal(tag(once, domain), once, JSON.stringify(gap));
    }
    // A general or unlabeled line without a tag run stays exactly as it is.
    assert.equal(tag(line, 'general'), line, JSON.stringify(gap));
    assert.equal(tagIndexText(line, new Map()), line, JSON.stringify(gap));
  }
});

test('tagIndexText takes any gap after the dash, and a line it changes gets " — "', () => {
  // No gap, a no-break space, a tab.
  for (const line of ['- [A](a.md) —[work] about', '- [A](a.md) —\u00a0[work] about', '- [A](a.md) —\t[work] about']) {
    assert.equal(tag(line, 'general'), '- [A](a.md) — about', line);
    assert.equal(tagIndexText(line, new Map()), '- [A](a.md) — about', line);
    assert.equal(tag(line, 'work'), '- [A](a.md) — [work] about', line);
    assert.equal(tag(line, 'personal'), '- [A](a.md) — [personal] about', line);
  }
  // Without a run, a general or unlabeled line stays byte for byte as it is.
  for (const line of ['- [A](a.md) —about', '- [A](a.md) —\u00a0about', '- [A](a.md) —\tabout', '- [A](a.md) —\u200b\u00a0about']) {
    assert.equal(tag(line, 'general'), line, line);
    assert.equal(tagIndexText(line, new Map()), line, line);
    assert.equal(tag(line, 'personal'), '- [A](a.md) — [personal] about', line);
  }
  // A line without the em dash after the link, or with a link into another folder, is not an index line.
  for (const line of [
    '- [A](a.md) [work] about', '- [A](a.md) -[work] about', '- [A](a.md) \u2013[work] about',
    '- [A](../x/a.md) —[work] about', '- [A](../x/a.md) —\t[work] about',
  ]) {
    assert.equal(tag(line, 'general'), line, line);
    assert.equal(tag(line, 'personal'), line, line);
  }
  const index = '# T\r\n- [A](a.md) —\t[personal] x\r\n- [B](b.md) —y\r\n';
  assert.equal(tagIndexText(index, new Map([['a.md', 'work']])), '# T\r\n- [A](a.md) — [work] x\r\n- [B](b.md) —y\r\n');
});

test('tagIndexText takes any gap between the link and the dash, and a line it changes gets ") — "', () => {
  const unlabeled = (text: string) => tagIndexText(text, new Map());
  // No gap, a no-break space, two spaces, tabs, a format character.
  for (const sep of ['—', '\u00a0— ', '  — ', '\t—\t', '\u200b— ']) {
    const line = `- [A](a.md)${sep}[work] x`;
    assert.equal(tag(line, 'general'), '- [A](a.md) — x', line);
    assert.equal(unlabeled(line), '- [A](a.md) — x', line);
    assert.equal(tag(line, 'work'), '- [A](a.md) — [work] x', line);
    assert.equal(tag(line, 'personal'), '- [A](a.md) — [personal] x', line);
    // Without a run, a general or unlabeled line stays byte for byte as it is.
    const bare = `- [A](a.md)${sep}x`;
    assert.equal(tag(bare, 'general'), bare, bare);
    assert.equal(unlabeled(bare), bare, bare);
    for (const input of [line, bare]) {
      for (const domain of DOMAINS) {
        const once = tag(input, domain);
        assert.equal(tag(once, domain), once, input);
      }
      assert.equal(unlabeled(unlabeled(input)), unlabeled(input), input);
    }
  }
  // The bullet stays exact: another bullet, an indent or a gap without the em dash is not an index line.
  for (const line of ['* [A](a.md) — [work] x', '+ [A](a.md) — [work] x', '  - [A](a.md) — [work] x', '- [A](a.md)\t[work] x']) {
    assert.equal(tag(line, 'general'), line, line);
    assert.equal(tag(line, 'personal'), line, line);
  }
});

test('tagIndexText takes control and default-ignorable characters as gaps', () => {
  // A BEL, a C1 control and a Hangul filler before the run, a variation selector inside the brackets, a
  // combining grapheme joiner and a Mongolian variation selector between the letters, NEL before the dash.
  const probes = [
    '- [A](a.md) — \u0007[work] about', '- [A](a.md) — \u0090[work] about', '- [A](a.md) — \u3164[work] about',
    '- [A](a.md) — [\ufe0fwork] about', '- [A](a.md) — [w\u034fork] about', '- [A](a.md) — [w\u180bork] about',
    '- [A](a.md)\u0085— [work] about',
  ];
  // The same kinds of character in lines without a run.
  const bare = ['- [A](a.md) — \u0007about', '- [A](a.md) — \u3164about', '- [A](a.md)\u0085— about', '- [A](a.md) —\ufe0f about'];
  for (const line of probes) {
    // A line end stays.
    for (const end of ['', '\r']) {
      const input = `${line}${end}`;
      assert.equal(tag(input, 'general'), `- [A](a.md) — about${end}`, input);
      assert.equal(tagIndexText(input, new Map()), `- [A](a.md) — about${end}`, input);
      assert.equal(tag(input, 'work'), `- [A](a.md) — [work] about${end}`, input);
      assert.equal(tag(input, 'personal'), `- [A](a.md) — [personal] about${end}`, input);
    }
  }
  assert.equal(tag('- [A](a.md) — [work]\u0090\r', 'general'), '- [A](a.md) — \r');
  // Without a run, a general or unlabeled line stays byte for byte as it is.
  for (const line of bare) {
    assert.equal(tag(line, 'general'), line, line);
    assert.equal(tagIndexText(line, new Map()), line, line);
  }
  for (const line of [...probes, ...bare]) {
    for (const domain of DOMAINS) {
      const once = tag(line, domain);
      assert.equal(tag(once, domain), once, line);
    }
    assert.equal(tagIndexText(tagIndexText(line, new Map()), new Map()), tagIndexText(line, new Map()), line);
  }
  // U+2800 BRAILLE PATTERN BLANK only renders blank; it is not a gap.
  assert.equal(tag('- [A](a.md) — \u2800[work] about', 'general'), '- [A](a.md) — \u2800[work] about');
});
