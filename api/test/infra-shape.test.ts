import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

const root = new URL('..', import.meta.url);
const infraDir = new URL('infra/', root);
const files = [
  'sst.config.ts',
  ...readdirSync(infraDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `infra/${f}`),
];
const read = (rel: string): string => readFileSync(new URL(rel, root), 'utf8');

describe('infrastructure source', () => {
  it('has the expected program files', () => {
    for (const f of ['sst.config.ts', 'infra/policies.ts', 'infra/storage.ts', 'infra/auth.ts', 'infra/api.ts']) {
      assert.ok(files.includes(f), f);
    }
  });

  it('builds the routes by iterating ROUTES', () => {
    const src = read('infra/api.ts');
    assert.match(src, /import\s*\{[^}]*\bROUTES\b[^}]*\}\s*from/);
    assert.match(src, /for\s*\(\s*const\s+\w+\s+of\s+ROUTES\s*\)|ROUTES\s*\.\s*(forEach|map)\s*\(/);
  });

  for (const [name, pattern] of [
    ['url: true', /url\s*:\s*true/],
    ['FunctionUrl', /FunctionUrl/i],
    ['authorizationType NONE', /authorizationType\s*:\s*["']NONE["']/],
    ['$default', /\$default/],
    ['a 12-digit number', /\b\d{12}\b/],
    ['a hard-coded region', /[a-z]{2}-[a-z]+-\d/],
  ] as const) {
    it(`contains no ${name}`, () => {
      for (const f of files) {
        assert.doesNotMatch(read(f), pattern, f);
      }
    });
  }

  it('forces the Node.js 24 runtime and arm64', () => {
    assert.match(read('sst.config.ts'), /\$transform\(\s*aws\.lambda\.Function[\s\S]*nodejs24\.x/);
    assert.match(read('infra/api.ts'), /arm64/);
  });

  it('requires AGENT_MEMORY_REGION', () => {
    assert.match(read('sst.config.ts'), /Set AGENT_MEMORY_REGION to the AWS region to deploy to\./);
  });
});
