import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { ApiError } from '../src/errors.ts';
import { createHandler } from '../src/handler.ts';
import type { Store } from '../src/store.ts';
import { fakeStore } from './fake-store.ts';

type Line = Record<string, unknown>;

function event(
  routeKey: string,
  opts: {
    query?: Record<string, string>;
    body?: string;
    base64?: boolean;
    clientId?: string | null;
  } = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims = opts.clientId === null ? {} : { client_id: opts.clientId ?? 'client-1' };
  return {
    routeKey,
    queryStringParameters: opts.query,
    body: opts.body,
    isBase64Encoded: opts.base64 ?? false,
    requestContext: { authorizer: { jwt: { claims, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function setup(initial: Record<string, string> = {}) {
  const store = fakeStore(initial);
  const lines: Line[] = [];
  const handler = createHandler({ store, log: (l) => lines.push(l as Line) });
  return { store, lines, handler };
}

const SNAPSHOT = JSON.stringify({
  notes: [{ path: 'agents/hermes/a-note.md', name: 'a-note', description: 'First', type: 'reference', body: 'hello world' }],
});

const writeBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ agent: 'hermes', name: 'my-note', description: 'A note', content: 'Hello', ...over });

function json(res: { body?: string }): any {
  return JSON.parse(res.body ?? '');
}

test('each route reaches its operation and returns 200 JSON', async () => {
  const { handler } = setup({
    'index/agents.json': SNAPSHOT,
    'mem/global/MEMORY.md': '- index',
    'mem/global/n.md': 'text',
  });
  const cases: Array<[string, Parameters<typeof event>[1], (b: any) => void]> = [
    ['GET /v1/scopes', {}, (b) => assert.deepEqual(b.scopes, [{ scope: 'agents/hermes', notes: 1 }])],
    ['GET /v1/index', { query: { scope: 'global' } }, (b) => assert.equal(b.index, '- index')],
    ['GET /v1/search', { query: { q: 'hello' } }, (b) => assert.equal(b.total, 1)],
    ['GET /v1/note', { query: { path: 'global/n.md' } }, (b) => assert.equal(b.content, 'text')],
    ['POST /v1/notes', { body: writeBody() }, (b) => assert.deepEqual(b, { path: 'agents/hermes/my-note.md', created: true })],
  ];
  for (const [route, opts, check] of cases) {
    const res = await handler(event(route, opts));
    assert.equal(res.statusCode, 200, route);
    assert.equal((res.headers as Record<string, string>)['content-type'], 'application/json');
    assert.equal((res.headers as Record<string, string>)['cache-control'], 'no-store');
    check(json(res));
  }
});

test('an unknown route key is 404 not_found', async () => {
  const { handler, lines } = setup();
  const res = await handler(event('GET /v1/nope'));
  assert.equal(res.statusCode, 404);
  assert.equal(json(res).error.code, 'not_found');
  assert.equal(lines[0]?.op, null);
});

test('invalid JSON and a missing or empty body give 400 invalid_request', async () => {
  const { handler } = setup();
  for (const body of ['{not json', undefined, '']) {
    const res = await handler(event('POST /v1/notes', { body }));
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error.code, 'invalid_request');
  }
});

test('an oversized body is 400 invalid_request', async () => {
  const { handler } = setup();
  const big = JSON.stringify({ content: 'x'.repeat(100_001) });
  const res = await handler(event('POST /v1/notes', { body: big }));
  assert.equal(res.statusCode, 400);
  assert.equal(json(res).error.code, 'invalid_request');
  // base64 inflates, so the limit applies to the decoded bytes.
  const small = Buffer.from(writeBody()).toString('base64');
  const ok = await handler(event('POST /v1/notes', { body: small, base64: true }));
  assert.equal(ok.statusCode, 200);
});

test('a base64 body is decoded', async () => {
  const { handler, store } = setup();
  const res = await handler(event('POST /v1/notes', { body: Buffer.from(writeBody()).toString('base64'), base64: true }));
  assert.equal(res.statusCode, 200);
  assert.ok(store.objects.has('agents/hermes/my-note.md'));
});

test('an ApiError maps to its status and body', async () => {
  const { handler } = setup();
  const res = await handler(event('GET /v1/note', { query: { path: 'global/missing.md' } }));
  assert.equal(res.statusCode, 404);
  assert.equal(json(res).error.code, 'not_found');
  const bad = await handler(event('GET /v1/index', { query: { scope: 'nope' } }));
  assert.equal(bad.statusCode, 400);
  assert.equal(json(bad).error.code, 'invalid_request');
  assert.equal(typeof json(bad).error.message, 'string');
});

test('an unexpected error is 500 with a fixed message and a log line without the message', async () => {
  const store: Store = {
    async get() {
      throw new Error('boom MARKER-ERR');
    },
    async put() {
      throw new Error('boom MARKER-ERR');
    },
  };
  const lines: Line[] = [];
  const handler = createHandler({ store, log: (l) => lines.push(l as Line) });
  const res = await handler(event('GET /v1/note', { query: { path: 'global/n.md' } }));
  assert.equal(res.statusCode, 500);
  assert.deepEqual(json(res), { error: { code: 'internal', message: 'internal error' } });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.error, 'Error');
  assert.equal(lines[0]?.status, 500);
  assert.ok(!JSON.stringify(lines).includes('MARKER-ERR'));
});

test('log lines carry client, op, scope, path, status and duration, and no request text', async () => {
  const { handler, lines } = setup({ 'index/agents.json': SNAPSHOT });
  await handler(event('GET /v1/search', { query: { q: 'MARKER-QUERY', scope: 'agents/hermes' }, clientId: 'abc' }));
  await handler(
    event('POST /v1/notes', {
      body: writeBody({ description: 'MARKER-DESC', content: 'MARKER-CONTENT' }),
      clientId: 'abc',
    }),
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.op, 'memory_search');
  assert.equal(lines[0]?.clientId, 'abc');
  assert.equal(lines[0]?.scope, 'agents/hermes');
  assert.equal(lines[0]?.status, 200);
  assert.equal(typeof lines[0]?.ms, 'number');
  assert.equal(lines[1]?.op, 'memory_write');
  assert.equal(lines[1]?.scope, 'agents/hermes');
  assert.equal(lines[1]?.path, 'agents/hermes/my-note.md');
  const text = JSON.stringify(lines);
  for (const marker of ['MARKER-QUERY', 'MARKER-DESC', 'MARKER-CONTENT']) assert.ok(!text.includes(marker), marker);
});

test('clientId is null without claims and scope/path are null for invalid input', async () => {
  const { handler, lines } = setup();
  await handler(event('GET /v1/note', { query: { path: 'bad/..//x' }, clientId: null }));
  assert.equal(lines[0]?.clientId, null);
  assert.equal(lines[0]?.scope, null);
  assert.equal(lines[0]?.path, null);
  assert.equal(lines[0]?.status, 400);
});

test('a read logs the validated path and its scope', async () => {
  const { handler, lines } = setup({ 'mem/global/n.md': 'x' });
  await handler(event('GET /v1/note', { query: { path: 'global/n.md' } }));
  assert.equal(lines[0]?.scope, 'global');
  assert.equal(lines[0]?.path, 'global/n.md');
});

test('importing the module needs no BUCKET and the default handler is exported', async () => {
  const mod = await import('../src/handler.ts');
  assert.equal(typeof mod.handler, 'function');
});

test('ApiError thrown by an operation keeps its status', async () => {
  const store: Store = {
    async get() {
      throw new ApiError(409, 'conflict', 'busy');
    },
    async put() {
      throw new ApiError(409, 'conflict', 'busy');
    },
  };
  const handler = createHandler({ store, log: () => {} });
  const res = await handler(event('GET /v1/note', { query: { path: 'global/n.md' } }));
  assert.equal(res.statusCode, 409);
  assert.equal(json(res).error.code, 'conflict');
});
