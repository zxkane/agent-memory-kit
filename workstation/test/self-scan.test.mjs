import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from '../lib/secret-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['.git', 'node_modules', '.superpowers']);

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

test('no file in the repository contains a complete secret-shaped literal', () => {
  const findings = [];
  for (const path of files(ROOT)) {
    for (const { id, line } of scanText(readFileSync(path, 'utf8'))) {
      findings.push(`${relative(ROOT, path)}:${line} ${id}`);
    }
  }
  assert.deepEqual(findings, []);
});
