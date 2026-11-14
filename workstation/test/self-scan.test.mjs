import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanText } from '../lib/secret-scan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Directories and generated files that are never source: VCS data, dependencies, and SST's
// local build output and generated types (all git-ignored; present only after a deployment).
const SKIP = new Set(['.git', 'node_modules', '.superpowers', '.sst', 'sst-env.d.ts']);

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (entry.isFile()) yield path;
  }
}

test('file selection skips .sst at any depth and sst-env.d.ts but keeps other files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-scan-'));
  try {
    mkdirSync(join(dir, 'a', '.sst', 'artifacts'), { recursive: true });
    mkdirSync(join(dir, '.sst'));
    mkdirSync(join(dir, 'a', 'src'));
    writeFileSync(join(dir, '.sst', 'x.mjs'), '');
    writeFileSync(join(dir, 'a', '.sst', 'artifacts', 'y.mjs'), '');
    writeFileSync(join(dir, 'a', 'sst-env.d.ts'), '');
    writeFileSync(join(dir, 'a', 'src', 'keep.ts'), '');
    writeFileSync(join(dir, 'a', 'sst.config.ts'), '');
    const found = [...files(dir)].map((p) => relative(dir, p)).sort();
    assert.deepEqual(found, [join('a', 'sst.config.ts'), join('a', 'src', 'keep.ts')].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no file in the repository contains a complete secret-shaped literal', () => {
  const findings = [];
  for (const path of files(ROOT)) {
    for (const { id, line } of scanText(readFileSync(path, 'utf8'))) {
      findings.push(`${relative(ROOT, path)}:${line} ${id}`);
    }
  }
  assert.deepEqual(findings, []);
});
