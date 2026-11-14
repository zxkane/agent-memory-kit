import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { ApiError } from '../src/errors.ts';
import { createHandler } from '../src/handler.ts';
import { RESOURCE_SERVER, ROUTES } from '../src/routes.ts';
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
    scope?: unknown;
  } = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims: Record<string, unknown> = opts.clientId === null ? {} : { client_id: opts.clientId ?? 'client-1' };
  if ('scope' in opts) {
    if (opts.scope !== undefined) claims.scope = opts.scope;
  } else {
    claims.scope = 'agent-memory/read agent-memory/write';
  }
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

const TOO_LARGE = 'the request body is too large';

function throwingStore(touched: string[]): Store {
  return {
    async get(key) {
      touched.push(key);
      throw new Error('store touched');
    },
    async put(key) {
      touched.push(key);
      throw new Error('store touched');
    },
  };
}

// A valid write body whose serialized size is exactly `bytes` (content is padded with `fill`).
function bodyOfSize(bytes: number, fill = 'x'): string {
  const base = JSON.stringify({ agent: 'hermes', name: 'my-note', description: 'A note', content: '' });
  const fillBytes = Buffer.byteLength(fill);
  const room = bytes - Buffer.byteLength(base);
  const count = Math.floor(room / fillBytes);
  const content = 'x'.repeat(room - count * fillBytes) + fill.repeat(count);
  const out = JSON.stringify({ agent: 'hermes', name: 'my-note', description: 'A note', content });
  assert.equal(Buffer.byteLength(out), bytes);
  return out;
}

test('an oversized body is rejected by the size limit before anything else', async () => {
  const touched: string[] = [];
  const lines: Line[] = [];
  const handler = createHandler({ store: throwingStore(touched), log: (l) => lines.push(l as Line) });
  const cases: Array<[string, Parameters<typeof event>[1]]> = [
    ['one byte over', { body: bodyOfSize(100_001) }],
    ['multi-byte characters', { body: bodyOfSize(100_002, '\u00e9') }],
    ['base64 of an oversized body', { body: Buffer.from(bodyOfSize(100_001)).toString('base64'), base64: true }],
  ];
  for (const [label, opts] of cases) {
    const res = await handler(event('POST /v1/notes', opts));
    assert.equal(res.statusCode, 400, label);
    assert.equal(json(res).error.code, 'invalid_request', label);
    assert.equal(json(res).error.message, TOO_LARGE, label);
  }
  assert.deepEqual(touched, []);
  assert.ok(lines.every((l) => l.status === 400));
});

test('a body of exactly 100000 bytes passes the size limit (even multi-byte)', async () => {
  const handler = createHandler({ store: throwingStore([]), log: () => {} });
  for (const opts of [
    { body: bodyOfSize(100_000) },
    { body: bodyOfSize(100_000, '\u00e9') },
    { body: Buffer.from(bodyOfSize(100_000)).toString('base64'), base64: true },
  ]) {
    const res = await handler(event('POST /v1/notes', opts));
    // The size check let it through; parseWrite then refuses the content (over 50000 bytes).
    assert.equal(res.statusCode, 400);
    assert.notEqual(json(res).error.message, TOO_LARGE);
    assert.match(json(res).error.message, /content/);
  }
});

test('base64 inflation does not count against the limit', async () => {
  const { handler } = setup();
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

const OTHER: Record<string, string> = { read: 'agent-memory/write', write: 'agent-memory/read' };
const ROUTE_EVENTS: Record<string, Parameters<typeof event>[1]> = {
  'GET /v1/scopes': {},
  'GET /v1/index': { query: { scope: 'global' } },
  'GET /v1/search': { query: { q: 'hello' } },
  'GET /v1/note': { query: { path: 'global/n.md' } },
  'POST /v1/notes': { body: writeBody() },
};

test('the token scope is checked per route (fail closed, store untouched on 403)', async () => {
  for (const route of ROUTES) {
    const key = `${route.method} ${route.path}`;
    const base = ROUTE_EVENTS[key]!;
    const own = `${RESOURCE_SERVER}/${route.scope}`;
    const { handler: ok } = setup({ 'index/agents.json': SNAPSHOT, 'mem/global/MEMORY.md': '- i', 'mem/global/n.md': 'x' });
    assert.equal((await ok(event(key, { ...base, scope: own }))).statusCode, 200, `${key} own`);
    assert.equal((await ok(event(key, { ...base, scope: 'agent-memory/read agent-memory/write' }))).statusCode, 200, `${key} both`);

    const touched: string[] = [];
    const lines: Line[] = [];
    const handler = createHandler({ store: throwingStore(touched), log: (l) => lines.push(l as Line) });
    const denied: unknown[] = [OTHER[route.scope], undefined, 42, ['agent-memory/read', 'agent-memory/write'], '', `x${own}`];
    for (const scope of denied) {
      const res = await handler(event(key, { ...base, scope }));
      assert.equal(res.statusCode, 403, `${key} ${JSON.stringify(scope)}`);
      assert.deepEqual(json(res), { error: { code: 'forbidden', message: 'the token does not allow this operation' } });
    }
    assert.deepEqual(touched, [], key);
    assert.ok(lines.every((l) => l.status === 403 && l.op === route.operationId));
  }
});

test('a suffix lookalike scope and tab-separated scopes are judged token by token', async () => {
  const read = ROUTE_EVENTS['GET /v1/note']!;
  const { handler } = setup({ 'mem/global/n.md': 'x' });
  for (const scope of ['agent-memory/readx', 'xagent-memory/read', 'agent-memory/readx\tagent-memory/writex']) {
    const res = await handler(event('GET /v1/note', { ...read, scope }));
    assert.equal(res.statusCode, 403, JSON.stringify(scope));
  }
  for (const scope of ['agent-memory/write\tagent-memory/read', 'agent-memory/read\tagent-memory/write']) {
    const res = await handler(event('GET /v1/note', { ...read, scope }));
    assert.equal(res.statusCode, 200, JSON.stringify(scope));
  }
});

// A read that is denied for an object that exists reads as missing. The conditional writes then
// fail, so the write ends as a 409 conflict and changes nothing.
test('a write whose reads are all denied ends as 409 conflict and changes nothing', async () => {
  const initial = {
    'index/agents.json': SNAPSHOT,
    'agents/hermes/MEMORY.md': '- [a-note](a-note.md) - First\n',
    'agents/hermes/a-note.md': 'text',
  };
  const store = fakeStore(initial, { deniedReads: true });
  const before = new Map(store.objects);
  const handler = createHandler({ store, log: () => {} });
  const res = await handler(event('POST /v1/notes', { body: writeBody() }));
  assert.equal(res.statusCode, 409);
  assert.equal(json(res).error.code, 'conflict');
  assert.deepEqual(store.objects, before);
});

const credential = () => 'sk-' + 'a1b2c3d4e5'.repeat(4).slice(0, 34);

test('a refused name, agent or path never reaches the log line', async () => {
  const secret = credential();
  const cases: Array<[string, Parameters<typeof event>[1]]> = [
    ['POST /v1/notes', { body: writeBody({ name: secret }) }],
    ['POST /v1/notes', { body: writeBody({ agent: secret }) }],
    ['GET /v1/note', { query: { path: `global/${secret}.md` } }],
    ['GET /v1/note', { query: { path: `projects/${secret}/n.md` } }],
    ['GET /v1/index', { query: { scope: `projects/${secret}` } }],
    ['GET /v1/search', { query: { q: 'hello', scope: `projects/${secret}` } }],
  ];
  for (const [route, opts] of cases) {
    const { handler, lines, store } = setup();
    const res = await handler(event(route, opts));
    assert.ok((res.statusCode ?? 0) < 500, `${route} ${res.statusCode}`);
    if (route === 'POST /v1/notes') assert.equal(json(res).error.code, 'secret_detected');
    assert.equal(store.objects.size, 0);
    assert.equal(lines.length, 1);
    assert.ok(!JSON.stringify(lines).includes(secret.slice(3)), route);
    assert.equal(lines[0]?.scope, null);
    assert.equal(lines[0]?.path, null);
  }
});

test('unknown query parameters are refused on the scopes and write routes', async () => {
  const { handler, store } = setup();
  const scopes = await handler(event('GET /v1/scopes', { query: { junk: '1' } }));
  assert.equal(scopes.statusCode, 400);
  assert.equal(json(scopes).error.code, 'invalid_request');
  const write = await handler(event('POST /v1/notes', { query: { junk: '1' }, body: writeBody() }));
  assert.equal(write.statusCode, 400);
  assert.equal(json(write).error.code, 'invalid_request');
  assert.equal(store.objects.size, 0);
});

test('a write is visible to search and read through the same handler', async () => {
  const { handler } = setup();
  const empty = await handler(event('GET /v1/search', { query: { q: 'zebrafish' } }));
  assert.equal(json(empty).total, 0);
  const put = await handler(
    event('POST /v1/notes', { body: writeBody({ name: 'fish', content: 'Notes about a zebrafish tank.' }) }),
  );
  assert.equal(put.statusCode, 200);
  const found = json(await handler(event('GET /v1/search', { query: { q: 'zebrafish' } })));
  assert.equal(found.total, 1);
  assert.equal(found.results[0].path, 'agents/hermes/fish.md');
  assert.match(JSON.stringify(found.results[0]), /zebrafish/);
  const read = json(await handler(event('GET /v1/note', { query: { path: 'agents/hermes/fish.md' } })));
  assert.match(read.content, /zebrafish tank/);
});
