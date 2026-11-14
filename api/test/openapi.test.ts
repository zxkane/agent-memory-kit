import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ApiError } from '../src/errors.ts';
import { memoryIndex } from '../src/ops/index.ts';
import { memoryRead } from '../src/ops/read.ts';
import { memorySearch } from '../src/ops/search.ts';
import { ROUTES } from '../src/routes.ts';
import { createSnapshots } from '../src/snapshot.ts';
import { WRITE_KEYS, parseWrite } from '../src/validate.ts';
import { fakeStore } from './fake-store.ts';

const DOC_URL = new URL('../openapi.json', import.meta.url);
const SCRIPT = new URL('../scripts/render-openapi.ts', import.meta.url).pathname;
const text = readFileSync(DOC_URL, 'utf8');
const doc = JSON.parse(text);

function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v);
      walk(v, visit);
    }
  }
}

function operations(): Array<{ method: string; path: string; op: any }> {
  const out = [];
  for (const [path, item] of Object.entries<any>(doc.paths)) {
    for (const [method, op] of Object.entries<any>(item)) out.push({ method: method.toUpperCase(), path, op });
  }
  return out;
}

test('document basics', () => {
  assert.equal(doc.openapi, '3.0.3');
  assert.equal(doc.info.title, 'Agent Memory API');
  assert.equal(doc.servers[0].url, 'https://example.com');
});

test('operations equal ROUTES', () => {
  const have = operations().map((o) => `${o.method} ${o.path} ${o.op.operationId}`).sort();
  const want = ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
  assert.deepEqual(have, want);
});

test('every operation has operationId, summary and description', () => {
  for (const { op } of operations()) {
    for (const key of ['operationId', 'summary', 'description']) {
      assert.equal(typeof op[key], 'string');
      assert.ok(op[key].length > 0);
    }
  }
});

test('no forbidden keys anywhere', () => {
  const found: string[] = [];
  walk(doc, (k) => {
    if (['oneOf', 'anyOf', 'allOf', 'securitySchemes', 'security'].includes(k)) found.push(k);
  });
  assert.deepEqual(found, []);
});

test('only application/json content', () => {
  const containers: any[] = [];
  for (const { op } of operations()) containers.push(op.requestBody, ...Object.values(op.responses));
  let seen = 0;
  for (const c of containers) {
    for (const type of Object.keys(c?.content ?? {})) {
      assert.equal(type, 'application/json');
      seen++;
    }
  }
  assert.ok(seen > 0);
});

test('parameters are simple query parameters', () => {
  for (const { op } of operations()) {
    for (const p of op.parameters ?? []) {
      assert.equal(p.in, 'query');
      assert.ok(['string', 'integer'].includes(p.schema.type), p.name);
    }
  }
});

test('required query parameters match validation', () => {
  const required = (id: string) =>
    (operations().find((o) => o.op.operationId === id)!.op.parameters ?? [])
      .filter((p: any) => p.required)
      .map((p: any) => p.name)
      .sort();
  const names = (id: string) =>
    (operations().find((o) => o.op.operationId === id)!.op.parameters ?? []).map((p: any) => p.name).sort();
  assert.deepEqual(names('memory_scopes'), []);
  assert.deepEqual(required('memory_index'), ['scope']);
  assert.deepEqual(names('memory_search'), ['limit', 'q', 'scope']);
  assert.deepEqual(required('memory_search'), ['q']);
  assert.deepEqual(names('memory_read'), ['path']);
  assert.deepEqual(required('memory_read'), ['path']);
});

const SAMPLE: Record<string, string> = {
  agent: 'hermes',
  name: 'my-note',
  description: 'A note',
  content: 'Hello',
  type: 'reference',
  scope: 'global',
  q: 'hello',
  limit: '5',
  path: 'global/n.md',
};

function accepts(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'invalid_request') return false;
    throw err;
  }
}

test('write request body behaves as the document says', () => {
  const op = operations().find((o) => o.op.operationId === 'memory_write')!.op;
  const schema = op.requestBody.content['application/json'].schema;
  assert.equal(schema.additionalProperties, false);
  const names: string[] = Object.keys(schema.properties);
  assert.deepEqual([...names].sort(), [...WRITE_KEYS].sort(), 'document properties and accepted keys');
  for (const n of names) assert.ok(n in SAMPLE, `no sample for ${n}`);
  const full = Object.fromEntries(names.map((n) => [n, SAMPLE[n]]));
  assert.ok(accepts(() => parseWrite(full)), 'full body');
  for (const n of names) {
    const without = { ...full };
    delete without[n];
    const required = (schema.required as string[]).includes(n);
    assert.equal(accepts(() => parseWrite(without)), !required, `dropping ${n}`);
  }
  assert.equal(accepts(() => parseWrite({ ...full, extra: 'x' })), false, 'extra key');
  for (const value of schema.properties.type.enum) {
    assert.ok(accepts(() => parseWrite({ ...full, type: value })), `type ${value}`);
  }
  assert.equal(accepts(() => parseWrite({ ...full, type: 'bogus' })), false);
});

test('query parameters behave as the document says', async () => {
  const store = fakeStore({
    'index/agents.json': JSON.stringify({ notes: [] }),
    'mem/global/MEMORY.md': '- i',
    'mem/global/n.md': 'x',
  });
  const snapshots = createSnapshots(store);
  const run: Record<string, (q: Record<string, string | undefined>) => Promise<unknown>> = {
    memory_index: (q) => memoryIndex({ store }, q),
    memory_search: (q) => memorySearch({ snapshots }, q),
    memory_read: (q) => memoryRead({ store }, q),
  };
  const ok = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_request') return false;
      if (err instanceof ApiError && err.code === 'not_found') return true;
      throw err;
    }
  };
  for (const { op } of operations()) {
    const params: any[] = op.parameters ?? [];
    if (op.operationId === 'memory_scopes') {
      assert.deepEqual(params, []);
      continue;
    }
    if (op.operationId === 'memory_write') continue;
    const call = run[op.operationId]!;
    const full = Object.fromEntries(params.map((p) => [p.name, SAMPLE[p.name]]));
    assert.ok(await ok(() => call(full)), `${op.operationId} full`);
    for (const p of params) {
      const without = { ...full };
      delete without[p.name];
      assert.equal(await ok(() => call(without)), !p.required, `${op.operationId} without ${p.name}`);
    }
    assert.equal(await ok(() => call({ ...full, unknown: 'x' })), false, `${op.operationId} unknown parameter`);
  }
});

test('no $ref and no components', () => {
  assert.equal('components' in doc, false);
  const found: string[] = [];
  walk(doc, (k) => {
    if (k === '$ref' || k === 'components') found.push(k);
  });
  assert.deepEqual(found, []);
});

test('every operation documents 403 forbidden with the error body', () => {
  for (const { op } of operations()) {
    const res = op.responses['403'];
    assert.ok(res, op.operationId);
    assert.deepEqual(Object.keys(res.content['application/json'].schema.properties), ['error']);
    assert.match(res.description, /scope/);
  }
  assert.match(text, /forbidden/);
});

test('memory_write says it cannot delete and explains both quota codes', () => {
  const by = (id: string) => operations().find((o) => o.op.operationId === id)!.op;
  assert.match(by('memory_write').description, /cannot delete/);
  const refused = by('memory_write').responses['400'].description;
  assert.match(refused, /scope_full \(this agent scope reached its limit of 200 notes or about 240 KB/);
  assert.match(refused, /store_full \(the store reached its limit of 16 agent scopes or its total size\)/);
});

test('every operation documents 400 and 500 with the error body', () => {
  for (const { op } of operations()) {
    for (const code of ['400', '500']) {
      const res = op.responses[code];
      assert.ok(res, `${op.operationId} ${code}`);
      assert.deepEqual(Object.keys(res.content['application/json'].schema.properties), ['error']);
    }
  }
});

test('200 schemas list every returned field as required', () => {
  const by = (id: string) => operations().find((o) => o.op.operationId === id)!.op;
  const schema = (id: string) => by(id).responses['200'].content['application/json'].schema;
  for (const { op } of operations()) {
    const s = op.responses['200'].content['application/json'].schema;
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), op.operationId);
  }
  const item = (s: any) => s.items;
  const scopes = item(schema('memory_scopes').properties.scopes);
  assert.deepEqual([...scopes.required].sort(), Object.keys(scopes.properties).sort());
  const results = item(schema('memory_search').properties.results);
  assert.deepEqual([...results.required].sort(), Object.keys(results.properties).sort());
});

test('responses list 200 and the documented errors', () => {
  for (const { op } of operations()) {
    assert.ok(op.responses['200']);
    assert.ok(op.responses['400']);
  }
  const by = (id: string) => operations().find((o) => o.op.operationId === id)!.op;
  assert.ok(by('memory_index').responses['404']);
  assert.ok(by('memory_read').responses['404']);
  assert.ok(by('memory_write').responses['409']);
  const props = (id: string) =>
    Object.keys(by(id).responses['200'].content['application/json'].schema.properties).sort();
  assert.deepEqual(props('memory_scopes'), ['scopes']);
  assert.deepEqual(props('memory_index'), ['index', 'scope', 'truncated']);
  assert.deepEqual(props('memory_search'), ['results', 'total']);
  assert.deepEqual(props('memory_read'), ['content', 'path', 'truncated']);
  assert.deepEqual(props('memory_write'), ['created', 'path']);
  const result = by('memory_search').responses['200'].content['application/json'].schema.properties.results.items;
  assert.deepEqual(Object.keys(result.properties).sort(), ['description', 'name', 'path', 'scope', 'score', 'snippet']);
});

test('no account ids or amazonaws.com', () => {
  assert.ok(!/(?<![0-9])[0-9]{12}(?![0-9])/.test(text));
  assert.ok(!text.includes('amazonaws.com'));
});

test('render-openapi replaces only servers[0].url and rejects http', () => {
  const out = execFileSync(process.execPath, [SCRIPT, 'https://memory.test.example'], { encoding: 'utf8' });
  const rendered = JSON.parse(out);
  assert.equal(rendered.servers[0].url, 'https://memory.test.example');
  rendered.servers[0].url = doc.servers[0].url;
  assert.deepEqual(rendered, doc);
  for (const bad of ['http://memory.test.example', 'memory.test.example', '']) {
    const res = spawnSync(process.execPath, [SCRIPT, bad], { encoding: 'utf8' });
    assert.notEqual(res.status, 0, bad);
  }
});
