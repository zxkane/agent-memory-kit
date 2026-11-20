import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseNote } from '../lib/notes.mjs';
import {
  LABELS, readDomain, setDomain, parseDomains, scopeDefault, readLabelInputs, tagLine, tagIndexLines,
} from '../lib/domains.mjs';

const NOTE = '---\nname: a\ndescription: d\nmetadata:\n  type: project\n  originSessionId: x\n---\n\nbody\n';
const GOOD = '{"version":1,"defaults":{"agents/example-agent":"work"},"exceptions":{}}';

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'domains-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('LABELS lists the three labels', () => {
  assert.deepEqual([...LABELS], ['work', 'personal', 'general']);
});

test('readDomain reads domain under metadata only', () => {
  assert.equal(readDomain(NOTE.replace('  originSessionId: x', '  domain: work')), 'work');
  assert.equal(readDomain(NOTE.replace('  originSessionId: x', '  domain: "personal"')), 'personal');
  assert.equal(readDomain(NOTE.replace('  originSessionId: x', '  domain: other')), null);
  assert.equal(readDomain(NOTE.replace('metadata:', 'domain: work\nmetadata:')), null);
  assert.equal(readDomain('no frontmatter'), null);
  assert.equal(readDomain('---\nmetadata:\n  domain: work\n'), null);
});

test('setDomain inserts after the last metadata line, with its indent', () => {
  assert.equal(setDomain(NOTE, 'work').text, NOTE.replace('  originSessionId: x\n', '  originSessionId: x\n  domain: work\n'));
  const four = NOTE.replace(/\n {2}/g, '\n    ');
  assert.ok(setDomain(four, 'work').text.includes('    originSessionId: x\n    domain: work\n---'));
});

test('setDomain replaces an existing domain', () => {
  const text = NOTE.replace('  originSessionId: x', '  domain: personal\n  originSessionId: x');
  const out = setDomain(text, 'work').text;
  assert.equal(out, NOTE.replace('  originSessionId: x', '  domain: work\n  originSessionId: x'));
  assert.equal(out.match(/domain:/g).length, 1);
});

test('setDomain leaves exactly one domain when several exist', () => {
  const text = NOTE.replace('  originSessionId: x', '  domain: personal\n  domain: general\n  originSessionId: x');
  const out = setDomain(text, 'work').text;
  assert.equal(out.match(/domain:/g).length, 1);
  assert.equal(readDomain(out), 'work');
});

test('setDomain adds a metadata block when there is none', () => {
  const text = '---\nname: a\ndescription: d\n---\nbody\n';
  assert.equal(setDomain(text, 'general').text, '---\nname: a\ndescription: d\nmetadata:\n  domain: general\n---\nbody\n');
});

test('setDomain keeps CRLF line ends', () => {
  const crlf = NOTE.replace(/\n/g, '\r\n');
  const out = setDomain(crlf, 'work').text;
  assert.ok(!/[^\r]\n/.test(out));
  assert.ok(out.includes('  domain: work\r\n'));
  const bare = '---\r\nname: a\r\n---\r\nb\r\n';
  assert.equal(setDomain(bare, 'work').text, '---\r\nname: a\r\nmetadata:\r\n  domain: work\r\n---\r\nb\r\n');
});

test('setDomain skips what it cannot edit', () => {
  assert.deepEqual(setDomain('body only', 'work'), { skip: 'no frontmatter' });
  assert.deepEqual(setDomain('---\nname: a\n', 'work'), { skip: 'frontmatter not closed' });
  assert.deepEqual(setDomain('---\nname: a\ndescription: d\nmetadata: {}\n---\n', 'work'), { skip: 'metadata is not a block' });
});

test('setDomain rejects a label outside LABELS', () => {
  assert.throws(() => setDomain(NOTE, 'other'), TypeError);
});

test('setDomain keeps what parseNote reads', () => {
  for (const text of [NOTE, NOTE.replace(/\n/g, '\r\n'), '---\nname: a\ndescription: d\n---\nb\n']) {
    assert.deepEqual(parseNote(setDomain(text, 'work').text), parseNote(text));
  }
});

test('parseDomains accepts the schema and names the first problem', () => {
  assert.equal(parseDomains(GOOD).problem, null);
  for (const [text, problem] of [
    ['not json', 'not JSON'], ['[]', 'not JSON'], ['null', 'not JSON'],
    ['{"version":2,"defaults":{},"exceptions":{}}', 'version'],
    ['{"version":1,"defaults":{},"exceptions":{},"x":1}', 'an unknown key'],
    ['{"version":1,"exceptions":{}}', 'defaults'],
    ['{"version":1,"defaults":[],"exceptions":{}}', 'defaults'],
    ['{"version":1,"defaults":{"projects/../x":"work"},"exceptions":{}}', 'defaults'],
    ['{"version":1,"defaults":{"global":"other"},"exceptions":{}}', 'defaults'],
    ['{"version":1,"defaults":{}}', 'exceptions'],
    ['{"version":1,"defaults":{},"exceptions":{"global/x.txt":"work"}}', 'exceptions'],
    ['{"version":1,"defaults":{},"exceptions":{"global/MEMORY.md":"work"}}', 'exceptions'],
    ['{"version":1,"defaults":{},"exceptions":{"global/x.md":"other"}}', 'exceptions'],
    ['{"version":1,"defaults":{},"exceptions":{"nowhere/x.md":"work"}}', 'exceptions'],
  ]) assert.equal(parseDomains(text).problem, problem, text);
});

test('parseDomains returns maps and scopeDefault falls back to general', () => {
  const { value } = parseDomains(
    '{"version":1,"defaults":{"global":"personal","projects/example-project":"work"},"exceptions":{"global/a.md":"work"}}');
  assert.equal(value.exceptions.get('global/a.md'), 'work');
  assert.equal(scopeDefault(value, 'global'), 'personal');
  assert.equal(scopeDefault(value, 'projects/example-project'), 'work');
  assert.equal(scopeDefault(value, 'agents/example-agent'), 'general');
});

test('readLabelInputs reads both files', t => {
  const dir = tmp(t);
  writeFileSync(join(dir, 'd.json'), GOOD);
  writeFileSync(join(dir, 'p.txt'), '  I work on things.\n');
  const out = readLabelInputs({ domainsFile: join(dir, 'd.json'), personaFile: join(dir, 'p.txt') });
  assert.equal(out.persona, 'I work on things.');
  assert.equal(out.domains.defaults.get('agents/example-agent'), 'work');
});

test('readLabelInputs names the file that is missing, empty or too long', t => {
  const dir = tmp(t);
  const d = join(dir, 'd.json'), p = join(dir, 'p.txt');
  assert.deepEqual(readLabelInputs({ domainsFile: d, personaFile: p }), { problem: 'domainsFile' });
  writeFileSync(d, GOOD);
  assert.deepEqual(readLabelInputs({ domainsFile: d, personaFile: p }), { problem: 'personaFile' });
  writeFileSync(p, ' \n');
  assert.deepEqual(readLabelInputs({ domainsFile: d, personaFile: p }), { problem: 'personaFile' });
  writeFileSync(p, 'x'.repeat(20001));
  assert.deepEqual(readLabelInputs({ domainsFile: d, personaFile: p }), { problem: 'personaFile' });
  writeFileSync(p, 'x'.repeat(20000));
  assert.equal(readLabelInputs({ domainsFile: d, personaFile: p }).persona.length, 20000);
  writeFileSync(d, '{"version":2,"defaults":{},"exceptions":{}}');
  assert.deepEqual(readLabelInputs({ domainsFile: d, personaFile: p }), { problem: 'domainsFile: version' });
});

test('readLabelInputs refuses symlinks, directories and large files', t => {
  const dir = tmp(t);
  const d = join(dir, 'd.json'), p = join(dir, 'p.txt');
  writeFileSync(join(dir, 'real.json'), GOOD);
  symlinkSync(join(dir, 'real.json'), d);
  writeFileSync(p, 'persona');
  assert.deepEqual(readLabelInputs({ domainsFile: d, personaFile: p }), { problem: 'domainsFile' });
  assert.deepEqual(readLabelInputs({ domainsFile: dir, personaFile: p }), { problem: 'domainsFile' });
  writeFileSync(join(dir, 'big.json'), ' '.repeat(1024 * 1024 + 1));
  assert.deepEqual(readLabelInputs({ domainsFile: join(dir, 'big.json'), personaFile: p }), { problem: 'domainsFile' });
  writeFileSync(d + '2', GOOD);
  assert.deepEqual(readLabelInputs({ domainsFile: d + '2', personaFile: dir }), { problem: 'personaFile' });
});

test('tagLine tags work and personal only', () => {
  assert.equal(tagLine('- [A](a.md) — about a', 'work'), '- [A](a.md) — [work] about a');
  assert.equal(tagLine('- [A](a.md) — about a', 'personal'), '- [A](a.md) — [personal] about a');
  assert.equal(tagLine('- [A](a.md) — about a', 'general'), '- [A](a.md) — about a');
  assert.equal(tagLine('- [A](a.md) — about a', null), '- [A](a.md) — about a');
});

test('tagLine leaves other lines alone', () => {
  for (const line of ['- [A](a.md) about a', '- [A](../x/a.md) — about a', '# Heading']) {
    assert.equal(tagLine(line, 'work'), line);
  }
});

test('tagLine also strips a tag token at the end of the line or before a tab', () => {
  assert.equal(tagLine('- [A](a.md) — [work]', 'general'), '- [A](a.md) — ');
  assert.equal(tagLine('- [A](a.md) — [work]', 'personal'), '- [A](a.md) — [personal] ');
  assert.equal(tagLine('- [A](a.md) — [personal]\r', 'general'), '- [A](a.md) — \r');
  assert.equal(tagLine('- [A](a.md) — [personal]\r', null), '- [A](a.md) — \r');
  assert.equal(tagLine('- [A](a.md) — [Work] \r', 'work'), '- [A](a.md) — [work] \r');
  // The white space right after the run goes with it; a line end stays.
  assert.equal(tagLine('- [A](a.md) — [work]\tabout a', 'general'), '- [A](a.md) — about a');
  assert.equal(tagLine('- [A](a.md) — [work]\tabout a', 'personal'), '- [A](a.md) — [personal] about a');
  assert.equal(tagLine('- [A](a.md) — about [work]', 'general'), '- [A](a.md) — about [work]');
  assert.equal(tagLine('- [A](a.md) — [workx] about a', 'general'), '- [A](a.md) — [workx] about a');
  for (const line of ['- [A](a.md) — [work]', '- [A](a.md) — [personal]\r', '- [A](a.md) — [work]\tx']) {
    const once = tagLine(line, 'work');
    assert.equal(tagLine(once, 'work'), once);
  }
});

test('tagLine takes the tag only from the note', () => {
  assert.equal(tagLine('- [A](a.md) — [work] about a', 'personal'), '- [A](a.md) — [personal] about a');
  assert.equal(tagLine('- [A](a.md) — [work] about a', 'general'), '- [A](a.md) — about a');
  assert.equal(tagLine('- [A](a.md) — [personal] about a', null), '- [A](a.md) — about a');
  assert.equal(tagLine('- [A](a.md) — [personal] [work] about a', 'work'), '- [A](a.md) — [work] about a');
  assert.equal(tagLine('- [A](a.md) — [personal] [work] about a', 'general'), '- [A](a.md) — about a');
  assert.equal(tagLine('- [A](a.md) — [work] about a', 'work'), '- [A](a.md) — [work] about a');
  assert.equal(tagLine('- [A](a.md) — about [work] a', 'personal'), '- [A](a.md) — [personal] about [work] a');
  assert.equal(tagLine('- [A](../x/a.md) — [work] about a', 'personal'), '- [A](../x/a.md) — [work] about a');
});

test('tagLine strips a leading tag run whatever its spacing, letter case or hidden characters', () => {
  // A session or an agent may write any of these into a hook; none of them may show as a tag.
  const probes = [
    '- [A](a.md) —  [work] about a',
    '- [A](a.md) — \u200b[work] about a',
    '- [A](a.md) — [Work] about a',
    '- [A](a.md) — [work]about a',
    '- [A](a.md) — [personal][work] about a',
    '- [A](a.md) — [w\u200bork] about a',
    '- [A](a.md) — \u2060[ PERSONAL ]\u00ad [wOrK]\u200b\t about a',
  ];
  for (const line of probes) {
    assert.equal(tagLine(line, null), '- [A](a.md) — about a', line);
    assert.equal(tagLine(line, 'general'), '- [A](a.md) — about a', line);
    assert.equal(tagLine(line, 'work'), '- [A](a.md) — [work] about a', line);
    assert.equal(tagLine(line, 'personal'), '- [A](a.md) — [personal] about a', line);
  }
});

test('tagLine keeps the rest of the hook exactly', () => {
  // Text that only looks like a tag, and format characters later in the hook, stay as they are.
  const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}';
  for (const hook of ['[Work in progress] about a', `trip with the ${family}`, '[workshop] notes', 'about [work] a']) {
    assert.equal(tagLine(`- [A](a.md) — ${hook}`, 'general'), `- [A](a.md) — ${hook}`, hook);
    assert.equal(tagLine(`- [A](a.md) — ${hook}`, 'work'), `- [A](a.md) — [work] ${hook}`, hook);
  }
  // Only the run and the white space or format characters right after it go.
  assert.equal(tagLine(`- [A](a.md) — [ work ] ${family} [personal]`, 'personal'), `- [A](a.md) — [personal] ${family} [personal]`);
  // A very long run of white space without a tag is left as it is, at once.
  const spaces = `- [A](a.md) — ${' '.repeat(200_000)}x`;
  assert.equal(tagLine(spaces, 'general'), spaces);
});

test('tagIndexLines reads each linked note of the folder', t => {
  const dir = tmp(t);
  writeFileSync(join(dir, 'a.md'), NOTE.replace('  originSessionId: x', '  domain: work'));
  writeFileSync(join(dir, 'b.md'), NOTE.replace('  originSessionId: x', '  domain: general'));
  mkdirSync(join(dir, 'd.md'));
  const lines = ['# Index', '- [A](a.md) — about a', '- [B](b.md) — about b', '- [C](c.md) — about c', '- [D](d.md) — about d'];
  assert.deepEqual(tagIndexLines(lines, dir), [
    '# Index', '- [A](a.md) — [work] about a', '- [B](b.md) — about b', '- [C](c.md) — about c', '- [D](d.md) — about d',
  ]);
});

test('tagIndexLines leaves the line of a note it may not read as it was', t => {
  const dir = tmp(t);
  const labeled = NOTE.replace('  originSessionId: x', '  domain: work');
  writeFileSync(join(dir, 'real.md'), labeled);
  symlinkSync(join(dir, 'real.md'), join(dir, 'link.md'));
  // Over the size limit, even with its label in the first lines.
  writeFileSync(join(dir, 'big.md'), labeled + 'x'.repeat(1024 * 1024));
  writeFileSync(join(dir, 'MEMORY.md'), '- [L](link.md) — [personal] about l\n- [B](big.md) — about b\n- [R](real.md) — about r\n');
  const index = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
  assert.deepEqual(tagIndexLines(index.split('\n'), dir), [
    '- [L](link.md) — [personal] about l', '- [B](big.md) — about b', '- [R](real.md) — [work] about r', '',
  ]);
  assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), index, 'MEMORY.md itself is never written');
});

test('tagIndexLines refuses a FIFO in place of a note without waiting for a writer', t => {
  const dir = tmp(t);
  assert.equal(spawnSync('mkfifo', [join(dir, 'f.md')]).status, 0);
  // In a child process with a time limit: a read that waited on the FIFO would hang the test run.
  const url = new URL('../lib/domains.mjs', import.meta.url).href;
  const code = `import { tagIndexLines } from ${JSON.stringify(url)};\n`
    + `process.stdout.write(JSON.stringify(tagIndexLines(['- [F](f.md) — about f'], ${JSON.stringify(dir)})));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.signal, null, 'the read did not wait');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['- [F](f.md) — about f']);
});
