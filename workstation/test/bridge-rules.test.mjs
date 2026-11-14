import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

// The source text of `const NAME = /.../;` (with or without `export`).
function ruleSource(text, name) {
  const m = new RegExp(`^(?:export )?const ${name} = (/.*/[a-z]*);$`, 'm').exec(text);
  assert.ok(m, `${name} not found`);
  return m[1];
}

test('the path rules of bridge up are the API rules, character for character', () => {
  const api = read('api/src/validate.ts');
  const up = read('workstation/lib/bridge-up.mjs');
  for (const name of ['PROJECT_RE', 'FILE_RE']) assert.equal(ruleSource(up, name), ruleSource(api, name), name);
});

test('the path rules of bridge down are the API rules, character for character', () => {
  const api = read('api/src/validate.ts');
  const down = read('workstation/lib/bridge-down.mjs');
  for (const name of ['AGENT_RE', 'FILE_RE']) assert.equal(ruleSource(down, name), ruleSource(api, name), name);
});
