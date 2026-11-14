import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ROUTES } from '../src/routes.ts';

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
  const containers: any[] = [...Object.values(doc.components.responses)];
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

test('write request body matches parseWrite', () => {
  const op = operations().find((o) => o.op.operationId === 'memory_write')!.op;
  const schema = op.requestBody.content['application/json'].schema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ['agent', 'content', 'description', 'name', 'type']);
  assert.deepEqual([...schema.required].sort(), ['agent', 'content', 'description', 'name']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.properties.type.enum].sort(), ['feedback', 'project', 'reference', 'user']);
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
