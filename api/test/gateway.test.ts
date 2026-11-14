import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { createHandler } from '../src/handler.ts';
import type { Store } from '../src/store.ts';
import { fakeStore } from './fake-store.ts';

type Line = Record<string, unknown>;
type Ctx = { clientContext?: { custom?: Record<string, unknown> } };

const SNAPSHOT = JSON.stringify({
  notes: [{ path: 'agents/assistant/a-note.md', name: 'a-note', description: 'First', type: 'reference', body: 'hello world' }],
});
const SEED = { 'index/agents.json': SNAPSHOT, 'mem/global/MEMORY.md': '- index', 'mem/global/n.md': 'text' };

function gatewayContext(tool: string, extra: Record<string, unknown> = {}): Ctx {
  return {
    clientContext: {
      custom: {
        bedrockAgentCoreToolName: `memory-target___${tool}`,
        bedrockAgentCoreGatewayId: 'gw-123',
        bedrockAgentCoreTargetId: 'TARGET01',
        bedrockAgentCoreMessageVersion: '1.0',
        ...extra,
      },
    },
  };
}

function httpEvent(routeKey: string, opts: { query?: Record<string, string>; body?: string; scope?: string } = {}) {
  return {
    routeKey,
    queryStringParameters: opts.query,
    body: opts.body,
    isBase64Encoded: false,
    requestContext: {
      authorizer: { jwt: { claims: { client_id: 'client-1', scope: opts.scope ?? 'agent-memory/read agent-memory/write' }, scopes: [] } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function setup(initial: Record<string, string> = SEED, direct: boolean | undefined = true) {
  const store = fakeStore(initial);
  const lines: Line[] = [];
  const handler = createHandler({ store, log: (l) => lines.push(l as Line), direct });
  const call = (tool: string, args: unknown, extra?: Record<string, unknown>) =>
    handler(args, gatewayContext(tool, extra)) as Promise<any>;
  return { store, lines, handler, call };
}

const WRITE = { agent: 'assistant', name: 'my-note', description: 'A note', content: 'Hello' };

test('each tool answers with the JSON body of the HTTP path for the same input', async () => {
  const cases: Array<{ tool: string; route: string; args: Record<string, unknown>; query?: Record<string, string>; body?: string }> = [
    { tool: 'memory_scopes', route: 'GET /v1/scopes', args: {} },
    { tool: 'memory_index', route: 'GET /v1/index', args: { scope: 'global' }, query: { scope: 'global' } },
    { tool: 'memory_search', route: 'GET /v1/search', args: { q: 'hello', scope: 'agents/assistant', limit: 5 }, query: { q: 'hello', scope: 'agents/assistant', limit: '5' } },
    { tool: 'memory_read', route: 'GET /v1/note', args: { path: 'global/n.md' }, query: { path: 'global/n.md' } },
    { tool: 'memory_write', route: 'POST /v1/notes', args: WRITE, body: JSON.stringify(WRITE) },
  ];
  for (const c of cases) {
    // Separate stores with the same content, so a write on one path does not change the other's answer.
    const viaGateway = await setup().call(c.tool, c.args);
    const viaHttp = await setup().handler(httpEvent(c.route, { query: c.query, body: c.body }));
    assert.equal(viaHttp.statusCode, 200, c.tool);
    assert.deepEqual(viaGateway, JSON.parse(viaHttp.body ?? ''), c.tool);
  }
});

test('the reply is a plain object, not an API Gateway response', async () => {
  const res = await setup().call('memory_scopes', {});
  assert.equal('statusCode' in res, false);
  assert.deepEqual(JSON.parse(JSON.stringify(res)), res);
});

test('limit as an integer and as a string give the same answer', async () => {
  const { call } = setup();
  const asInt = await call('memory_search', { q: 'hello', limit: 1 });
  const asString = await call('memory_search', { q: 'hello', limit: '1' });
  assert.deepEqual(asInt, asString);
  assert.equal(asInt.results.length, 1);
});

test('a note written through a tool can be read back through a tool', async () => {
  const { call } = setup();
  const written = await call('memory_write', WRITE);
  assert.deepEqual(written, { path: 'agents/assistant/my-note.md', created: true });
  const read = await call('memory_read', { path: written.path });
  assert.match(read.content, /Hello/);
});

test('the tool is the text after the first three underscores', async () => {
  const { handler } = setup();
  const nested = await handler({}, { clientContext: { custom: { bedrockAgentCoreToolName: 'a___b___memory_scopes' } } });
  assert.deepEqual(nested, { error: { code: 'not_found', message: 'unknown tool' } });
  const single = (await handler({}, { clientContext: { custom: { bedrockAgentCoreToolName: 'x_y___memory_scopes' } } })) as any;
  assert.ok(Array.isArray(single.scopes));
});

test('unknown tools and names without the separator are not_found', async () => {
  const { handler, lines } = setup();
  for (const name of ['memory_scopes', 'target__memory_scopes', 'target___memory_delete', 'target___', 'target___MEMORY_READ', '']) {
    const res = await handler({}, { clientContext: { custom: { bedrockAgentCoreToolName: name } } });
    assert.deepEqual(res, { error: { code: 'not_found', message: 'unknown tool' } }, name);
  }
  assert.ok(lines.every((l) => l.status === 404 && l.op === null));
});

test('the arguments must be a plain object', async () => {
  const { call, store } = setup();
  for (const args of [null, undefined, [], ['global'], 'global', 5, true]) {
    const res = await call('memory_scopes', args);
    assert.deepEqual(res, { error: { code: 'invalid_request', message: 'The arguments must be a JSON object.' } });
  }
  assert.deepEqual(store.gets, []);
});

test('values of other types are invalid_request; only limit may be an integer', async () => {
  const { call, store } = setup();
  const bad: Array<[string, Record<string, unknown>]> = [
    ['memory_search', { q: 5 }],
    ['memory_search', { q: 'hello', limit: 1.5 }],
    ['memory_search', { q: 'hello', limit: null }],
    ['memory_search', { q: 'hello', limit: true }],
    ['memory_search', { q: 'hello', scope: ['global'] }],
    ['memory_index', { scope: { a: 1 } }],
    ['memory_read', { path: null }],
  ];
  for (const [tool, args] of bad) {
    const res = await call(tool, args);
    assert.equal(res.error.code, 'invalid_request', JSON.stringify(args));
  }
  assert.deepEqual(store.gets, []);
});

test('every refusal of the HTTP path is the same on the gateway path', async () => {
  const long = 'x'.repeat(50_001);
  const cases: Array<{ tool: string; route: string; args: Record<string, string | number>; body?: Record<string, unknown> }> = [
    { tool: 'memory_scopes', route: 'GET /v1/scopes', args: { extra: 'x' } },
    { tool: 'memory_index', route: 'GET /v1/index', args: { scope: 'global', extra: 'x' } },
    { tool: 'memory_index', route: 'GET /v1/index', args: {} },
    { tool: 'memory_search', route: 'GET /v1/search', args: { q: 'hello', limit: 21 } },
    { tool: 'memory_search', route: 'GET /v1/search', args: { q: 'hello', limit: 0 } },
    { tool: 'memory_search', route: 'GET /v1/search', args: { q: 'hello', limit: '1e1' } },
    { tool: 'memory_search', route: 'GET /v1/search', args: { q: 'hello', scope: 'nowhere' } },
    { tool: 'memory_read', route: 'GET /v1/note', args: { path: '../secret.md' } },
    { tool: 'memory_read', route: 'GET /v1/note', args: { path: 'global/missing.md' } },
    { tool: 'memory_index', route: 'GET /v1/index', args: { scope: 'projects/none' } },
    { tool: 'memory_write', route: 'POST /v1/notes', args: {}, body: { ...WRITE, agent: 'global/x' } },
    { tool: 'memory_write', route: 'POST /v1/notes', args: {}, body: { ...WRITE, extra: 'x' } },
    { tool: 'memory_write', route: 'POST /v1/notes', args: {}, body: { ...WRITE, content: long } },
    { tool: 'memory_write', route: 'POST /v1/notes', args: {}, body: { ...WRITE, type: 'bogus' } },
    // Within every field limit, but more than 100000 bytes once serialised.
    { tool: 'memory_write', route: 'POST /v1/notes', args: {}, body: { ...WRITE, content: '\n'.repeat(50_000) } },
    { tool: 'memory_write', route: 'POST /v1/notes', args: {}, body: { ...WRITE, name: 'memory' } },
  ];
  for (const c of cases) {
    const gateway = await setup().call(c.tool, c.body ?? c.args);
    const http = await setup().handler(
      httpEvent(
        c.route,
        c.body
          ? { body: JSON.stringify(c.body) }
          : { query: Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, String(v)])) },
      ),
    );
    assert.ok((http.statusCode ?? 0) >= 400, JSON.stringify(c).slice(0, 150));
    assert.deepEqual(gateway, JSON.parse(http.body ?? ''), JSON.stringify(c).slice(0, 150));
  }
});

test('a write to a scope outside agents/ is refused and writes nothing', async () => {
  const { call, store } = setup();
  const before = [...store.objects.keys()].sort();
  for (const agent of ['global/x', 'projects/demo', '../x', '']) {
    assert.equal((await call('memory_write', { ...WRITE, agent })).error.code, 'invalid_request');
  }
  assert.deepEqual([...store.objects.keys()].sort(), before);
});

test('without direct, the invocation is refused and the store is not touched', async () => {
  for (const direct of [undefined, false] as const) {
    const calls: string[] = [];
    const guarded: Store = {
      async get(key) {
        calls.push(`get ${key}`);
        throw new Error('touched');
      },
      async put(key) {
        calls.push(`put ${key}`);
        throw new Error('touched');
      },
    };
    const lines: Line[] = [];
    const handler = createHandler({ store: guarded, log: (l) => lines.push(l as Line), ...(direct === undefined ? {} : { direct }) });
    const attempts: Array<[string, unknown]> = [
      ['memory_scopes', {}],
      ['memory_write', WRITE],
      ['memory_read', { path: 'global/n.md' }],
      ['nothing', null],
    ];
    for (const [tool, args] of attempts) {
      const res = await handler(args, gatewayContext(tool));
      assert.deepEqual(res, { error: { code: 'forbidden', message: 'direct invocation is not enabled' } });
    }
    assert.deepEqual(calls, []);
    assert.ok(lines.every((l) => l.status === 403 && l.scope === null && l.path === null));
  }
});

test('an HTTP event whose body or query names a tool is still an HTTP request with its scope check', async () => {
  const { handler, store } = setup();
  const trick = { bedrockAgentCoreToolName: 'x___memory_scopes' };
  const query = httpEvent('GET /v1/scopes', { query: trick, scope: 'other/thing' });
  assert.equal(((await handler(query)) as any).statusCode, 403);
  const body = httpEvent('POST /v1/notes', { body: JSON.stringify({ ...WRITE, ...trick }), scope: 'agent-memory/read' });
  assert.equal(((await handler(body)) as any).statusCode, 403);
  const allowed = httpEvent('POST /v1/notes', { body: JSON.stringify({ ...WRITE, ...trick }) });
  assert.equal(((await handler(allowed)) as any).statusCode, 400, 'the extra field is refused as on any HTTP write');
  assert.deepEqual([...store.objects.keys()].sort(), Object.keys(SEED).sort());
});

test('an HTTP event with a context that has no tool name is handled as HTTP', async () => {
  const { handler } = setup(SEED, false);
  const contexts: unknown[] = [
    undefined,
    {},
    { clientContext: {} },
    { clientContext: { custom: {} } },
    { clientContext: { custom: { bedrockAgentCoreToolName: 5 } } },
    { clientContext: { custom: { bedrockAgentCoreToolName: null } } },
  ];
  for (const context of contexts) {
    const denied = (await handler(httpEvent('GET /v1/scopes', { scope: 'other/thing' }), context as Ctx)) as any;
    assert.equal(denied.statusCode, 403);
    const ok = (await handler(httpEvent('GET /v1/scopes'), context as Ctx)) as any;
    assert.equal(ok.statusCode, 200);
  }
});

test('a gateway invocation whose event looks like an HTTP event is just arguments', async () => {
  const { call, store } = setup();
  const forged = {
    routeKey: 'GET /v1/scopes',
    requestContext: { authorizer: { jwt: { claims: { scope: 'agent-memory/read agent-memory/write' } } } },
  };
  assert.equal((await call('memory_scopes', forged)).error.code, 'invalid_request');
  assert.equal((await call('memory_write', { ...forged, ...WRITE })).error.code, 'invalid_request');
  assert.deepEqual([...store.objects.keys()].sort(), Object.keys(SEED).sort());
});

test('a __proto__ argument is an unknown argument, not a way past the check', async () => {
  const { call } = setup();
  const args = JSON.parse('{"scope":"global","__proto__":"x"}');
  assert.equal((await call('memory_index', args)).error.code, 'invalid_request');
});

test('a failing store gives an internal error, not an exception', async () => {
  const lines: Line[] = [];
  const broken: Store = {
    async get() {
      throw new TypeError('secret detail');
    },
    async put() {
      throw new Error('secret detail');
    },
  };
  const handler = createHandler({ store: broken, log: (l) => lines.push(l as Line), direct: true });
  const res = await handler({ path: 'global/n.md' }, gatewayContext('memory_read'));
  assert.deepEqual(res, { error: { code: 'internal', message: 'internal error' } });
  assert.equal(lines[0]?.status, 500);
  assert.equal(lines[0]?.error, 'TypeError');
  assert.ok(!JSON.stringify(lines).includes('secret detail'));
});

test('the gateway log line has the HTTP fields plus via, gateway and target, and no text', async () => {
  const { call, lines, handler } = setup();
  await call('memory_read', { path: 'global/n.md' });
  await call('memory_write', { ...WRITE, content: 'NOTE-TEXT-SENTINEL' });
  await call('memory_search', { q: 'SEARCH-SENTINEL' });
  await call('memory_read', { path: 'global/missing.md' });
  await handler(httpEvent('GET /v1/note', { query: { path: 'global/n.md' } }));
  const [read, write, search, missing, http] = lines as [Line, Line, Line, Line, Line];
  for (const l of [read, write, search, missing]) {
    assert.deepEqual(Object.keys(l).sort(), ['clientId', 'gateway', 'ms', 'op', 'path', 'scope', 'status', 'target', 'via']);
    assert.equal(l.clientId, null);
    assert.equal(l.via, 'gateway');
    assert.equal(l.gateway, 'gw-123');
    assert.equal(l.target, 'TARGET01');
  }
  assert.deepEqual(
    { ...read, ms: 0 },
    { op: 'memory_read', clientId: null, scope: 'global', path: 'global/n.md', status: 200, ms: 0, via: 'gateway', gateway: 'gw-123', target: 'TARGET01' },
  );
  assert.equal(write.path, 'agents/assistant/my-note.md');
  assert.equal(write.scope, 'agents/assistant');
  assert.equal(search.scope, null);
  assert.equal(missing.status, 404);
  assert.ok(!JSON.stringify(lines).includes('SENTINEL'));
  assert.deepEqual(Object.keys(http).sort(), ['clientId', 'ms', 'op', 'path', 'scope', 'status']);
  assert.equal(http.clientId, 'client-1');
});

test('gateway and target ids that do not look like ids are logged as null', async () => {
  const { call, lines } = setup();
  await call('memory_scopes', {}, { bedrockAgentCoreGatewayId: 'bad id with spaces', bedrockAgentCoreTargetId: 'x'.repeat(101) });
  await call('memory_scopes', {}, { bedrockAgentCoreGatewayId: 7, bedrockAgentCoreTargetId: undefined });
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.equal(l.gateway, null);
    assert.equal(l.target, null);
  }
});

test('the log line of a refused or failed invocation carries the status the HTTP path would set', async () => {
  const { call, lines } = setup();
  await call('memory_search', { q: 'hello', limit: 99 });
  await call('memory_search', { q: 'hello', scope: 'global', limit: 3, extra: 'x' });
  await call('nothing', {});
  assert.deepEqual(lines.map((l) => l.status), [400, 400, 404]);
  assert.equal(lines[1]?.scope, 'global');
});

test('a write over the body size limit is refused and writes nothing', async () => {
  const { call, store } = setup();
  const res = await call('memory_write', { ...WRITE, content: '\n'.repeat(50_000) });
  assert.deepEqual(res, { error: { code: 'invalid_request', message: 'the request body is too large' } });
  assert.deepEqual([...store.objects.keys()].sort(), Object.keys(SEED).sort());
});

test('the client context custom values may arrive as custom or as Custom', async () => {
  const keys = ['custom', 'Custom'];
  for (const key of keys) {
    const context = { clientContext: { [key]: { bedrockAgentCoreToolName: 't___memory_scopes', bedrockAgentCoreGatewayId: 'gw-9', bedrockAgentCoreTargetId: 'T9' } } };
    const on = setup();
    const res = (await on.handler({}, context as Ctx)) as any;
    assert.ok(Array.isArray(res.scopes), key);
    assert.equal(on.lines[0]?.via, 'gateway', key);
    assert.equal(on.lines[0]?.gateway, 'gw-9', key);
    assert.equal(on.lines[0]?.target, 'T9', key);
    const off = setup(SEED, false);
    assert.deepEqual(await off.handler({}, context as Ctx), { error: { code: 'forbidden', message: 'direct invocation is not enabled' } }, key);
    assert.deepEqual(off.store.gets, []);
  }
  const { handler } = setup();
  const neither = (await handler(httpEvent('GET /v1/scopes'), { clientContext: { Custom: {}, custom: {} } } as Ctx)) as any;
  assert.equal(neither.statusCode, 200);
});

test('without a gateway context, an event that is not an object is an unknown route and does not throw', async () => {
  for (const event of [null, undefined, 'text', 5, []]) {
    const { handler, lines } = setup();
    const res = (await handler(event as never, { clientContext: { custom: { bedrockAgentCoreToolName: 5 } } } as Ctx)) as any;
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error.message, 'unknown route');
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.op, null);
    assert.equal(lines[0]?.status, 404);
    assert.equal('via' in lines[0]!, false);
  }
});

test('an unknown tool is reported before a non-object event', async () => {
  const { handler } = setup();
  const res = await handler(null, gatewayContext('nothing'));
  assert.deepEqual(res, { error: { code: 'not_found', message: 'unknown tool' } });
});

test('a refused argument still leaves the valid scope and path in the log line', async () => {
  const { call, lines, handler } = setup();
  await call('memory_search', { q: 5, scope: 'global' });
  await call('memory_read', { path: 'global/n.md', extra: 5 });
  await handler(httpEvent('GET /v1/search', { query: { q: 'x', scope: 'global', limit: '99' } }));
  assert.equal(lines[0]?.status, 400);
  assert.equal(lines[0]?.scope, 'global');
  assert.equal(lines[1]?.scope, 'global');
  assert.equal(lines[1]?.path, 'global/n.md');
  assert.equal(lines[2]?.scope, 'global');
});

test('the exported handler enables direct invocation only for DIRECT_INVOCATION=on', async () => {
  const saved = { bucket: process.env.BUCKET, direct: process.env.DIRECT_INVOCATION };
  const refused = { error: { code: 'forbidden', message: 'direct invocation is not enabled' } };
  const log = console.log;
  console.log = () => {};
  // The handler reads the variable when it is first used, so each case loads a fresh copy of the module.
  const load = async (n: number) => ((await import(`../src/handler.ts?case=${n}`)) as typeof import('../src/handler.ts')).handler;
  try {
    process.env.BUCKET = 'placeholder-bucket';
    let n = 0;
    for (const value of ['ON', 'true', '', 'off', undefined]) {
      if (value === undefined) delete process.env.DIRECT_INVOCATION;
      else process.env.DIRECT_INVOCATION = value;
      assert.deepEqual(await (await load(++n))({}, gatewayContext('memory_scopes')), refused, String(value));
    }
    process.env.DIRECT_INVOCATION = 'on';
    assert.deepEqual(await (await load(++n))({}, gatewayContext('nothing')), { error: { code: 'not_found', message: 'unknown tool' } });
  } finally {
    console.log = log;
    for (const [name, value] of [['BUCKET', saved.bucket], ['DIRECT_INVOCATION', saved.direct]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
