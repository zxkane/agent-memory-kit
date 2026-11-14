import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ChecksStoppedError, formatResult, makeMintToken, runChecks, ScopeNotAllowedError } from '../scripts/verify-deployed.ts';
import { composeNote } from '../src/note-file.ts';
import type { CheckResult } from '../scripts/verify-deployed.ts';

const BASE = 'https://api.example.com';
const TOKEN_ENDPOINT = 'https://auth.example.com/oauth2/token';
const ISSUER = 'https://idp.example.com/pool';

// Secret-looking values are built at run time so that no file holds a literal credential.
const SIGNATURE_MARKER = ['sig', 'marker', String(process.pid)].join('-');
const SECRET_MARKER = ['probe', 'secret', 'marker', String(process.pid)].join('-');

function b64(value: unknown): string {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

function makeToken(scopes: string[], exp: number): string {
  return [b64({ alg: 'RS256', typ: 'JWT' }), b64({ iss: ISSUER, scope: scopes.join(' '), exp }), SIGNATURE_MARKER].join('.');
}

const withRequired = (doc: any) => {
  for (const item of Object.values<any>(doc.paths)) {
    for (const op of Object.values<any>(item)) {
      const schema = op.responses[200].content['application/json'].schema;
      schema.required = Object.keys(schema.properties);
    }
  }
  return doc;
};

const OPENAPI = withRequired({
  paths: {
    '/v1/scopes': { get: { operationId: 'memory_scopes', responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { scopes: {} } } } } } } } },
    '/v1/index': { get: { operationId: 'memory_index', responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { scope: {}, index: {}, truncated: {} } } } } } } } },
    '/v1/search': { get: { operationId: 'memory_search', responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { results: {}, total: {} } } } } } } } },
    '/v1/note': { get: { operationId: 'memory_read', responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { path: {}, content: {}, truncated: {} } } } } } } } },
    '/v1/notes': { post: { operationId: 'memory_write', responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { path: {}, created: {} } } } } } } } },
  },
});

type Quirks = {
  noAuthStatus?: number;
  readTokenOnWrite?: boolean;
  // The gateway lets a read-only token through, so the function answers 403 with its own body.
  functionForbids?: boolean;
  omit?: { path: string; field: string };
  rejectWrite?: boolean;
  // Status of a read of a missing note or index (a role without list permission gives 500).
  missingStatus?: number;
  unknownPathStatus?: number;
  expiredStatus?: number;
  writeReply?: { status: number; code?: string } | 'network';
  // A value that every response body carries, to prove it is never copied into output.
  bodyMarker?: string;
};

// A fake API that follows the real one's behaviour unless a quirk changes it.
function fakeApi(valid: Set<string>, quirks: Quirks = {}) {
  const notes = new Map<string, string>();
  const calls: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}`);
    const header = new Headers(init?.headers).get('authorization');
    if (header === null) {
      return quirks.noAuthStatus === 200 ? json(200, { scopes: [] }) : json(401, { message: 'Unauthorized' });
    }
    const token = header.replace(/^Bearer /, '');
    if (!valid.has(token)) return json(401, { message: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    if (quirks.expiredStatus !== undefined && payload.exp * 1000 <= (fake.clock.value)) {
      return json(quirks.expiredStatus, { message: 'Unauthorized' });
    }
    if (payload.exp * 1000 <= fake.clock.value) return json(401, { message: 'Unauthorized' });
    const granted: string[] = payload.scope.split(' ');
    const reply = (path: string, body: Record<string, unknown>) => {
      const o = quirks.omit;
      if (o !== undefined && o.path === path) delete body[o.field];
      if (quirks.bodyMarker !== undefined) body.extra = quirks.bodyMarker;
      return json(200, body);
    };
    switch (`${method} ${url.pathname}`) {
      case 'GET /v1/scopes':
        return reply('/v1/scopes', { scopes: [...new Set([...notes.keys()].map((k) => k.split('/').slice(0, 2).join('/')))].map((scope) => ({ scope, notes: 1 })) });
      case 'GET /v1/index': {
        const scope = url.searchParams.get('scope');
        const lines = [...notes.keys()].filter((k) => k.startsWith(`${scope}/`)).map((k) => `- [${k}](${k})`);
        if (lines.length === 0) return quirks.missingStatus === undefined ? json(404, { error: { code: 'not_found', message: 'x' } }) : json(quirks.missingStatus, { error: { code: 'internal', message: 'x' } });
        return reply('/v1/index', { scope, index: lines.join('\n'), truncated: false });
      }
      case 'GET /v1/search':
        return reply('/v1/search', { results: [], total: 0 });
      case 'GET /v1/note': {
        const path = url.searchParams.get('path')!;
        if (notes.has(path)) return reply('/v1/note', { path, content: notes.get(path), truncated: false });
        return quirks.missingStatus === undefined ? json(404, { error: { code: 'not_found', message: 'x' } }) : json(quirks.missingStatus, { error: { code: 'internal', message: 'x' } });
      }
      case 'POST /v1/notes': {
        if (!granted.includes('agent-memory/write') && !quirks.readTokenOnWrite) {
          return quirks.functionForbids ? json(403, { error: { code: 'forbidden', message: 'x' } }) : json(403, { message: 'Forbidden' });
        }
        if (quirks.rejectWrite) return json(400, { error: { code: 'store_full', message: 'x' } });
        if (quirks.writeReply === 'network') throw new TypeError(`connect failed ${quirks.bodyMarker ?? ''}`);
        if (quirks.writeReply) return json(quirks.writeReply.status, { error: { code: quirks.writeReply.code ?? 'internal', message: 'x' } });
        const body = JSON.parse(String(init?.body));
        const path = `agents/${body.agent}/${body.name}.md`;
        const created = !notes.has(path);
        notes.set(path, composeNote({ name: body.name, description: body.description, type: body.type ?? 'reference', content: body.content }));
        return reply('/v1/notes', { path, created });
      }
      default:
        return json(quirks.unknownPathStatus ?? 404, { message: 'Not Found' });
    }
  };
  const fake = { fetch, calls, notes, clock: { value: 1_700_000_000_000 } };
  return fake;
}

function setup(quirks: Quirks = {}, options: { expired?: boolean; stage?: string } = {}) {
  const valid = new Set<string>();
  const fake = fakeApi(valid, quirks);
  const minted: string[][] = [];
  const mintToken = async (scopes: string[]) => {
    minted.push(scopes);
    const token = makeToken(scopes, fake.clock.value / 1000 + 300);
    valid.add(token);
    return token;
  };
  const sleeps: number[] = [];
  const run = () =>
    runChecks({
      fetch: fake.fetch,
      config: { apiUrl: BASE, tokenEndpoint: TOKEN_ENDPOINT },
      mintToken,
      now: () => fake.clock.value,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        fake.clock.value += ms;
      },
      openapi: OPENAPI,
      ...options,
    });
  return { fake, minted, sleeps, run };
}

const byNumber = (results: CheckResult[], n: number) => results.filter((r) => r.name.startsWith(`${n}.`) || r.name.startsWith(`${n}a.`) || r.name.startsWith(`${n}b.`));

test('a correct API passes every check', async () => {
  const { run } = setup();
  const results = await run();
  assert.ok(results.length >= 7);
  assert.deepEqual(results.filter((r) => !r.ok), []);
  for (const n of [1, 2, 3, 4, 5, 6, 7]) assert.ok(byNumber(results, n).length >= 1, `check ${n} present`);
});

test('check 1 fails when a route answers 200 without a token', async () => {
  const { run } = setup({ noAuthStatus: 200 });
  const failed = (await run()).filter((r) => !r.ok);
  assert.ok(failed.some((r) => r.name.startsWith('1.')));
});

test('check 4 fails when the read-only token is accepted on the write route', async () => {
  const { run } = setup({ readTokenOnWrite: true });
  const failed = (await run()).filter((r) => !r.ok);
  assert.ok(failed.some((r) => r.name.startsWith('4.')));
});

test('check 4 passes only on the gateway\'s own 403, not on the function\'s', async () => {
  const ok = (await setup().run()).find((r) => r.name.startsWith('4.'))!;
  assert.equal(ok.ok, true);
  const bad = (await setup({ functionForbids: true }).run()).find((r) => r.name.startsWith('4.'))!;
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /the gateway let the request through; the route may have lost its scope/);
});

for (const missingStatus of [500, 403]) {
  test(`check 5a fails when a missing note or index answers ${missingStatus}`, async () => {
    const { run } = setup({ missingStatus });
    const failed = (await run()).filter((r) => !r.ok && r.name.startsWith('5a.'));
    assert.equal(failed.length, 2, JSON.stringify(failed));
    for (const r of failed) assert.match(r.detail, /list permission/);
  });
}

test('check 5a expects 404 not_found for a missing note and a missing index scope', async () => {
  const { run, fake } = setup();
  const results = await run();
  const five = results.filter((r) => r.name.startsWith('5a.'));
  assert.equal(five.length, 4);
  assert.ok(five.every((r) => r.ok));
  assert.ok(fake.calls.includes('GET /v1/note') && fake.calls.includes('GET /v1/index'));
});

test('on prod a token that can write is a failure and 5b does not run', async () => {
  const { run, fake } = setup({}, { stage: 'prod' });
  const results = await run();
  const failed = results.filter((r) => !r.ok);
  assert.equal(failed.length, 1, JSON.stringify(failed));
  assert.match(failed[0]!.detail, /the probe client must be read-only on prod/);
  assert.equal(fake.notes.size, 0);
  // Three refused posts (checks 1-3) and the read-only post of check 4; no probe write follows.
  assert.equal(fake.calls.filter((c) => c === 'POST /v1/notes').length, 4);
  assert.deepEqual(results.filter((r) => r.name.startsWith('5b.') && r.ok), []);
});

test('on prod a read-only probe client passes and 5b is skipped; other stages are unchanged', async () => {
  const valid = new Set<string>();
  const fake = fakeApi(valid);
  const results = await runChecks({
    fetch: fake.fetch,
    config: { apiUrl: BASE, tokenEndpoint: TOKEN_ENDPOINT },
    mintToken: async (scopes) => {
      if (scopes.includes('agent-memory/write')) throw new ScopeNotAllowedError('no write scope');
      const token = makeToken(scopes, 2_000_000_000);
      valid.add(token);
      return token;
    },
    now: () => fake.clock.value,
    sleep: async () => {},
    openapi: OPENAPI,
    stage: 'prod',
  });
  assert.deepEqual(results.filter((r) => !r.ok), []);
  assert.equal(results.filter((r) => r.skipped).length, 1);
  const dev = await setup({}, { stage: 'dev' }).run();
  assert.ok(dev.some((r) => r.name.startsWith('5b.') && r.ok && !r.skipped));
});

test('check 6 fails when the description has no required list', async () => {
  const bare: any = JSON.parse(JSON.stringify(OPENAPI));
  delete bare.paths['/v1/scopes'].get.responses[200].content['application/json'].schema.required;
  const valid = new Set<string>();
  const fake = fakeApi(valid);
  const results = await runChecks({
    fetch: fake.fetch,
    config: { apiUrl: BASE, tokenEndpoint: TOKEN_ENDPOINT },
    mintToken: async (scopes) => {
      const token = makeToken(scopes, 2_000_000_000);
      valid.add(token);
      return token;
    },
    now: () => fake.clock.value,
    sleep: async () => {},
    openapi: bare,
  });
  assert.ok(results.some((r) => !r.ok && r.name.startsWith('6.') && r.detail.includes('memory_scopes')));
});

test('check 6 fails when a response lacks a required field', async () => {
  const { run } = setup({ omit: { path: '/v1/note', field: 'truncated' } });
  const failed = (await run()).filter((r) => !r.ok);
  assert.ok(failed.some((r) => r.name.startsWith('6.') && r.detail.includes('truncated')));
});

test('check 7 fails when an unknown path answers 200', async () => {
  const { run } = setup({ unknownPathStatus: 200 });
  assert.ok((await run()).some((r) => !r.ok && r.name.startsWith('7.')));
});

test('a probe client without the write scope skips 5b and everything else passes', async () => {
  const valid = new Set<string>();
  const fake = fakeApi(valid);
  const results = await runChecks({
    fetch: fake.fetch,
    config: { apiUrl: BASE, tokenEndpoint: TOKEN_ENDPOINT },
    mintToken: async (scopes) => {
      if (scopes.includes('agent-memory/write')) throw new ScopeNotAllowedError('no write scope');
      const token = makeToken(scopes, 2_000_000_000);
      valid.add(token);
      return token;
    },
    now: () => fake.clock.value,
    sleep: async () => {},
    openapi: OPENAPI,
  });
  assert.deepEqual(results.filter((r) => !r.ok), []);
  const skipped = results.filter((r) => r.skipped);
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0]!.name.startsWith('5b.'));
  assert.ok(skipped[0]!.detail.includes('the probe client has no write scope on this stage'));
  assert.ok(results.some((r) => r.name.startsWith('4.') && r.ok));
  assert.ok(results.filter((r) => r.name.startsWith('5a.')).length === 4);
  assert.deepEqual([...fake.notes.keys()], []);
});

test('a mint failure other than a refused scope is an error', async () => {
  await assert.rejects(
    runChecks({
      fetch: setup().fake.fetch,
      config: { apiUrl: BASE, tokenEndpoint: TOKEN_ENDPOINT },
      mintToken: async () => {
        throw new Error('token endpoint down');
      },
      now: () => 0,
      sleep: async () => {},
      openapi: OPENAPI,
    }),
    (err: unknown) => err instanceof ChecksStoppedError && !err.message.includes('token endpoint down'),
  );
});

test('a granted write scope runs 5b', async () => {
  const { run, fake } = setup();
  const results = await run();
  assert.ok(results.filter((r) => r.name.startsWith('5b.') && r.ok && !r.skipped).length >= 3);
  assert.ok(fake.notes.has('agents/probe/deployed-check.md'));
});

test('a rejected write skips the follow-up reads instead of failing', async () => {
  const { run } = setup({ rejectWrite: true });
  const results = await run();
  assert.deepEqual(results.filter((r) => !r.ok), []);
  assert.ok(results.some((r) => r.name.startsWith('5b.') && r.skipped === true));
});

test('the probe asks for exactly the scopes each check needs', async () => {
  const { run, minted } = setup();
  await run();
  assert.ok(minted.some((s) => s.length === 1 && s[0] === 'agent-memory/read'));
  assert.ok(minted.some((s) => s.includes('agent-memory/read') && s.includes('agent-memory/write')));
});

test('--expired waits past the token expiry and expects 401', async () => {
  const { run, sleeps } = setup({}, { expired: true });
  const results = await run();
  assert.deepEqual(results.filter((r) => !r.ok), []);
  assert.ok(byNumber(results, 8).length === 1);
  assert.ok(sleeps.length > 0 && sleeps.reduce((a, b) => a + b, 0) >= 300_000);
});

test('--expired fails when the expired token is still accepted', async () => {
  const { run } = setup({ expiredStatus: 200 }, { expired: true });
  assert.ok((await run()).some((r) => !r.ok && r.name.startsWith('8.')));
});

test('without --expired nothing sleeps', async () => {
  const { run, sleeps } = setup();
  await run();
  assert.deepEqual(sleeps, []);
});

test('results never contain a token, a signature or a secret', async () => {
  const { run } = setup();
  const text = JSON.stringify(await run());
  assert.ok(!text.includes(SIGNATURE_MARKER));
  assert.ok(!text.includes(SECRET_MARKER));
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(text));
  assert.ok(!/Bearer/i.test(text));
});

test('a network failure is reported without leaking the error message', async () => {
  const leaky = ['leak', SECRET_MARKER].join(':');
  const results = await runChecks({
    fetch: async () => {
      throw new Error(leaky);
    },
    config: { apiUrl: BASE, tokenEndpoint: TOKEN_ENDPOINT },
    mintToken: async (scopes) => makeToken(scopes, 2_000_000_000),
    now: () => 1_700_000_000_000,
    sleep: async () => {},
    openapi: OPENAPI,
  });
  assert.ok(results.some((r) => !r.ok));
  assert.ok(!JSON.stringify(results).includes(SECRET_MARKER));
});

test('importing the module does not run the command line', async () => {
  // Reaching this line proves the import at the top did not exit or read parameters.
  assert.equal(typeof runChecks, 'function');
});

test('the repository openapi.json is read when none is injected', async () => {
  const valid = new Set<string>();
  const fake = fakeApi(valid);
  const results = await runChecks({
    fetch: fake.fetch,
    config: { apiUrl: BASE, tokenEndpoint: TOKEN_ENDPOINT },
    mintToken: async (scopes) => {
      const token = makeToken(scopes, 2_000_000_000);
      valid.add(token);
      return token;
    },
    now: () => fake.clock.value,
    sleep: async () => {},
  });
  assert.deepEqual(results.filter((r) => !r.ok), []);
  assert.ok(results.some((r) => r.name.startsWith('6.') && r.detail.includes('memory_write')));
});

test('the command line refuses a missing stage before touching AWS', () => {
  const run = spawnSync(process.execPath, [new URL('../scripts/verify-deployed.ts', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Usage/);
});

const writeCases: Array<[string, Quirks['writeReply'], boolean]> = [
  ['500', { status: 500, code: 'internal' }, false],
  ['403 with a write-scope token', { status: 403, code: 'forbidden' }, false],
  ['401', { status: 401 }, false],
  ['400 invalid_request', { status: 400, code: 'invalid_request' }, false],
  ['400 secret_detected', { status: 400, code: 'secret_detected' }, false],
  ['a network error', 'network', false],
  ['400 scope_full', { status: 400, code: 'scope_full' }, true],
  ['400 store_full', { status: 400, code: 'store_full' }, true],
];
for (const [label, writeReply, skips] of writeCases) {
  test(`5b: a write answering ${label} ${skips ? 'is skipped' : 'fails'}`, async () => {
    const { run } = setup({ writeReply });
    const results = await run();
    const five = results.filter((r) => r.name.startsWith('5b.'));
    if (skips) {
      assert.deepEqual(results.filter((r) => !r.ok), []);
      assert.ok(five.length === 1 && five[0]!.skipped === true);
    } else {
      assert.ok(five.some((r) => !r.ok && !r.skipped), JSON.stringify(five));
    }
  });
}

test('5b: the read-back accepts the stored file with front matter and rejects a wrong body', async () => {
  const { run, fake } = setup();
  const results = await run();
  const read = results.find((r) => r.name.startsWith('5b. memory_read'))!;
  assert.ok(read.ok);
  assert.match(fake.notes.get('agents/probe/deployed-check.md')!, /^---\nname: deployed-check\n/);
});

test('5b: a read-back without the body text fails', async () => {
  const valid = new Set<string>();
  const fake = fakeApi(valid);
  const inner = fake.fetch;
  const results = await runChecks({
    fetch: async (input, init) => {
      const res = await inner(input, init);
      if (new URL(String(input)).pathname !== '/v1/note') return res;
      const body = await res.json();
      return new Response(JSON.stringify({ ...body, content: '---\nname: other\n---\n\nsomething else\n' }), { status: 200 });
    },
    config: { apiUrl: BASE, tokenEndpoint: TOKEN_ENDPOINT },
    mintToken: async (scopes) => {
      const token = makeToken(scopes, 2_000_000_000);
      valid.add(token);
      return token;
    },
    now: () => fake.clock.value,
    sleep: async () => {},
    openapi: OPENAPI,
  });
  assert.ok(results.some((r) => r.name.startsWith('5b. memory_read') && !r.ok));
});

test('markers carried by the token, the client secret and a response body never reach the output', async () => {
  const bodyMarker = ['body', 'marker', String(process.pid)].join('-');
  const lines: string[] = [];
  const valid = new Set<string>();
  const api = fakeApi(valid, { bodyMarker });
  const tokenCalls: RequestInit[] = [];
  const mint = makeMintToken({
    fetch: async (_url, init) => {
      tokenCalls.push(init!);
      const token = makeToken(String(init!.body).includes('write') ? ['agent-memory/read', 'agent-memory/write'] : ['agent-memory/read'], 2_000_000_000);
      valid.add(token);
      return new Response(JSON.stringify({ access_token: token }), { status: 200 });
    },
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: 'probe-client',
    clientSecret: SECRET_MARKER,
    timeoutMs: 1000,
  });
  const results = await runChecks({
    fetch: api.fetch,
    config: { apiUrl: BASE, tokenEndpoint: TOKEN_ENDPOINT },
    mintToken: mint,
    now: () => api.clock.value,
    sleep: async () => {},
    openapi: OPENAPI,
    onResult: (r) => lines.push(formatResult(r)),
  });
  assert.ok(tokenCalls.length >= 2);
  const secretSent = Buffer.from(String(new Headers(tokenCalls[0]!.headers).get('authorization')).replace('Basic ', ''), 'base64').toString();
  assert.ok(secretSent.includes(SECRET_MARKER), 'the secret is used for the token request');
  const everything = JSON.stringify(results) + lines.join('\n');
  for (const marker of [SIGNATURE_MARKER, SECRET_MARKER, bodyMarker]) assert.ok(!everything.includes(marker), marker);
  assert.equal(lines.length, results.length);
});

test('runChecks reports each result as produced and names the stage of a failure without the message', async () => {
  const valid = new Set<string>();
  const fake = fakeApi(valid);
  const lines: string[] = [];
  const leaky = ['leaky', SECRET_MARKER].join('-');
  let mints = 0;
  await assert.rejects(
    runChecks({
      fetch: fake.fetch,
      config: { apiUrl: BASE, tokenEndpoint: TOKEN_ENDPOINT },
      mintToken: async (scopes) => {
        if (++mints === 2) throw new Error(leaky);
        const token = makeToken(scopes, 2_000_000_000);
        valid.add(token);
        return token;
      },
      now: () => fake.clock.value,
      sleep: async () => {},
      openapi: OPENAPI,
      onResult: (r) => lines.push(formatResult(r)),
    }),
    (err: unknown) => {
      assert.ok(err instanceof ChecksStoppedError);
      assert.ok(!err.message.includes(SECRET_MARKER));
      assert.match(err.message, /Error/);
      assert.ok(err.step.length > 0);
      return true;
    },
  );
  assert.ok(lines.length >= 3, 'checks 1-3 were reported before the failure');
});

test('a request that never answers fails its check without a real wait', async () => {
  const valid = new Set<string>();
  const fake = fakeApi(valid);
  const hang = async (_input: string, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    });
  const started = Date.now();
  const results = await runChecks({
    fetch: hang,
    config: { apiUrl: BASE, tokenEndpoint: TOKEN_ENDPOINT },
    mintToken: async (scopes) => {
      const token = makeToken(scopes, 2_000_000_000);
      valid.add(token);
      return token;
    },
    now: () => fake.clock.value,
    sleep: async () => {},
    openapi: OPENAPI,
    timeoutMs: 5,
  });
  assert.ok(Date.now() - started < 5000);
  assert.ok(results.some((r) => r.name.startsWith('1.') && !r.ok && r.detail.includes('TimeoutError')));
});

test('a token request that never answers is aborted', async () => {
  const mint = makeMintToken({
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      }),
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: 'c',
    clientSecret: 's',
    timeoutMs: 5,
  });
  await assert.rejects(mint(['agent-memory/read']), (err: Error) => err.name === 'TimeoutError');
});

test('the token request maps invalid_scope to ScopeNotAllowedError', async () => {
  const mint = makeMintToken({
    fetch: async () => new Response(JSON.stringify({ error: 'invalid_scope' }), { status: 400 }),
    tokenEndpoint: TOKEN_ENDPOINT,
    clientId: 'c',
    clientSecret: 's',
    timeoutMs: 1000,
  });
  await assert.rejects(mint(['agent-memory/write']), ScopeNotAllowedError);
});
