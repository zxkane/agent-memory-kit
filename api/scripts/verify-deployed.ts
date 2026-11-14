// Usage: node scripts/verify-deployed.ts --stage <stage> [--region <region>] [--expired]
//
// Run after a deployment. Reads the stage's SSM parameters, requests tokens for the "probe" client
// and checks that the API refuses what it must refuse and serves what it must serve. Prints one
// PASS/FAIL line per check and exits non-zero when any check fails or errors. Tokens and the probe
// secret are held in memory only and are never printed.
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { RESOURCE_SERVER, ROUTES } from '../src/routes.ts';

export type CheckResult = { name: string; ok: boolean; detail: string; skipped?: boolean };

// Thrown by mintToken when the probe client may not have a requested scope (Cognito answers the
// token request with HTTP 400 and invalid_scope). runChecks treats it as a skip, not an error.
export class ScopeNotAllowedError extends Error {}

// Thrown by runChecks when it cannot continue. It names the step and the error class only, never
// the original message, which could hold a token or a response body.
export class ChecksStoppedError extends Error {
  step: string;
  constructor(step: string, errorName: string) {
    super(`checks stopped during ${step} (${errorName})`);
    this.name = 'ChecksStoppedError';
    this.step = step;
  }
}

export function formatResult(r: CheckResult): string {
  return `${r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${r.name} - ${r.detail}`;
}

const REQUEST_TIMEOUT_MS = 15_000;

// Requests the probe client's access tokens. A refused scope becomes ScopeNotAllowedError. The
// client secret stays in this closure.
export function makeMintToken(options: {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  timeoutMs?: number;
}): (scopes: string[]) => Promise<string> {
  const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64');
  return async (scopes) => {
    const res = await options.fetch(options.tokenEndpoint, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: scopes.join(' ') }),
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const body: any = await res.json().catch(() => null);
    if (res.status === 400 && body?.error === 'invalid_scope') {
      throw new ScopeNotAllowedError(`scope not allowed for the probe client: ${scopes.join(' ')}`);
    }
    if (!res.ok || typeof body?.access_token !== 'string') {
      throw new Error(`token request for ${scopes.join(' ')} failed with status ${res.status}`);
    }
    return body.access_token;
  };
}

export type Config = { apiUrl: string; tokenEndpoint: string };

type Reply = { status: number; body: unknown };

export type Deps = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  config: Config;
  mintToken: (scopes: string[]) => Promise<string>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  // Parsed openapi.json; read from the repository when omitted.
  openapi?: any;
  // Check 8: wait for a probe token to expire and expect 401.
  expired?: boolean;
  // Called with each result as it is produced.
  onResult?: (result: CheckResult) => void;
  // Timeout of each request, in milliseconds. Default 15000.
  timeoutMs?: number;
  // The stage under test. On prod the probe client must not be able to write.
  stage?: string;
};

const READ = `${RESOURCE_SERVER}/read`;
const WRITE = `${RESOURCE_SERVER}/write`;
const PROBE_AGENT = 'probe';
const PROBE_NAME = 'deployed-check';
const PROBE_PATH = `agents/${PROBE_AGENT}/${PROBE_NAME}.md`;
const EXPIRY_MARGIN_MS = 10_000;
const SLEEP_STEP_MS = 30_000;

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

// A well-formed RS256 token signed with a key that exists only in this process, so its issuer is
// not the deployment's issuer.
function forgeToken(nowMs: number): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const exp = Math.floor(nowMs / 1000) + 300;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'other-issuer' }));
  const claims = b64url(
    JSON.stringify({
      iss: 'https://idp.example.com/other-pool',
      sub: 'forged',
      client_id: 'forged-client',
      token_use: 'access',
      scope: `${READ} ${WRITE}`,
      iat: exp - 300,
      exp,
    }),
  );
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

function tokenExpiry(token: string): number | null {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

// Required response fields of an operation: the `required` list of its 200 schema, or null when
// the description has none (which check 6 reports as a failure).
function requiredFields(openapi: any, method: string, path: string): string[] | null {
  const schema = openapi?.paths?.[path]?.[method.toLowerCase()]?.responses?.['200']?.content?.['application/json']?.schema;
  return Array.isArray(schema?.required) ? schema.required : null;
}

export async function runChecks(deps: Deps): Promise<CheckResult[]> {
  const progress = { step: 'start' };
  try {
    return await runSteps(deps, progress);
  } catch (err) {
    throw new ChecksStoppedError(progress.step, err instanceof Error ? err.name : 'unknown');
  }
}

async function runSteps(deps: Deps, progress: { step: string }): Promise<CheckResult[]> {
  const { config, mintToken, now, sleep } = deps;
  const openapi = deps.openapi ?? JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
  const base = config.apiUrl.replace(/\/+$/, '');
  const results: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail: string, skipped = false) => {
    const result: CheckResult = skipped ? { name, ok, detail, skipped } : { name, ok, detail };
    results.push(result);
    deps.onResult?.(result);
  };

  async function call(method: string, path: string, options: { token?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<Reply | { error: string }> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = {};
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    try {
      const res = await deps.fetch(url.toString(), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(deps.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: the status is still useful.
      }
      return { status: res.status, body };
    } catch (err) {
      // Only the error class: the message of a network error may echo a URL.
      return { error: err instanceof Error ? err.name : 'unknown' };
    }
  }

  const describe = (r: Reply | { error: string }) => ('error' in r ? `network error (${r.error})` : String(r.status));

  // Sends one request per route and expects the given status from each.
  async function everyRoute(name: string, token: string | undefined, expected: number[], label: string) {
    const parts: string[] = [];
    let ok = true;
    for (const route of ROUTES) {
      const reply = await call(route.method, route.path, {
        token,
        body: route.method === 'POST' ? {} : undefined,
        query: route.method === 'GET' ? { scope: 'global', path: 'global/x.md', q: 'x' } : undefined,
      });
      parts.push(`${route.operationId} ${describe(reply)}`);
      if ('error' in reply || !expected.includes(reply.status)) ok = false;
    }
    add(name, ok, `${label}: ${parts.join(', ')}`);
  }

  const forged = forgeToken(now());
  progress.step = 'checks 1-3';
  await everyRoute('1. no Authorization header is refused', undefined, [401], 'expect 401');
  await everyRoute('2. a malformed token is refused', 'not-a-token', [401], 'expect 401');
  await everyRoute('3. a token from another issuer is refused', forged, [401], 'expect 401');

  // Mint first so that the expiry wait of check 8 starts as early as possible.
  progress.step = 'requesting a probe token';
  const expiryToken = deps.expired === true ? await mintToken([READ]) : undefined;

  const probeNote = {
    agent: PROBE_AGENT,
    name: PROBE_NAME,
    description: 'Written by the deployed check',
    content: 'Deployed check note. It may be replaced at any time.\n',
  };

  // Check 4
  progress.step = 'check 4';
  const readToken = await mintToken([READ]);
  const forbidden = await call('POST', '/v1/notes', { token: readToken, body: probeNote });
  // API Gateway's own refusal has the body {"message":"Forbidden"}; the function's refusal carries
  // error.code. Only the gateway's answer proves the route itself requires the write scope.
  const byFunction = !('error' in forbidden) && forbidden.status === 403 && typeof (forbidden.body as any)?.error?.code === 'string';
  add(
    '4. a read-only token cannot write',
    !('error' in forbidden) && forbidden.status === 403 && !byFunction,
    byFunction
      ? `POST /v1/notes with only ${READ}: 403 from the function; the gateway let the request through; the route may have lost its scope`
      : `POST /v1/notes with only ${READ}: ${describe(forbidden)}, expect 403 from the gateway`,
  );

  // Check 5a: positive read checks with a read-only token.
  const replies = new Map<string, Reply>();
  const fetched = async (token: string, operation: string, method: string, path: string, options: Parameters<typeof call>[2]) => {
    const reply = await call(method, path, { token, ...options });
    if (!('error' in reply)) replies.set(operation, reply);
    return reply;
  };
  progress.step = 'check 5a';
  const scopes0 = await fetched(readToken, 'memory_scopes', 'GET', '/v1/scopes', {});
  const scopesOk = !('error' in scopes0) && scopes0.status === 200 && Array.isArray((scopes0.body as any)?.scopes);
  add('5a. memory_scopes answers with a scopes array', scopesOk, `status ${describe(scopes0)}`);
  const search = await fetched(readToken, 'memory_search', 'GET', '/v1/search', { query: { q: 'deployed check' } });
  const searchOk = !('error' in search) && search.status === 200 && Array.isArray((search.body as any)?.results) && typeof (search.body as any)?.total === 'number';
  add('5a. memory_search answers with results and total', searchOk, `status ${describe(search)}`);

  // A missing note and a missing scope must read as 404 not_found. The store reads both a 404 and
  // the 403 that S3 gives a missing key to a role without list permission as missing.
  const expectNotFound = (name: string, reply: Reply | { error: string }, what: string) => {
    const ok = !('error' in reply) && reply.status === 404 && (reply.body as any)?.error?.code === 'not_found';
    add(name, ok, ok ? `${what}: 404 not_found` : `${what}: ${describe(reply)}, expect 404 not_found; a missing object did not read as not found`);
  };
  expectNotFound(
    '5a. memory_read of a missing note answers 404 not_found',
    await call('GET', '/v1/note', { token: readToken, query: { path: `agents/${PROBE_AGENT}/no-such-note.md` } }),
    'memory_read',
  );
  expectNotFound(
    '5a. memory_index of a missing scope answers 404 not_found',
    await call('GET', '/v1/index', { token: readToken, query: { scope: 'agents/no-such-agent' } }),
    'memory_index',
  );

  // Check 5b: write, then read it back. Needs a token with the write scope, which the probe client
  // does not have on every stage.
  progress.step = 'check 5b';
  let bothToken: string | undefined;
  try {
    bothToken = await mintToken([READ, WRITE]);
  } catch (err) {
    if (!(err instanceof ScopeNotAllowedError)) throw err;
  }
  if (bothToken === undefined) {
    add('5b. write and read back a note', true, 'SKIP: the probe client has no write scope on this stage', true);
  } else if (deps.stage === 'prod') {
    add('5b. the probe client is read-only on prod', false, 'a token with the write scope was issued on prod; the probe client must be read-only on prod, so 5b did not run');
  } else {
    const write = await fetched(bothToken, 'memory_write', 'POST', '/v1/notes', { body: probeNote });
    if (!('error' in write) && write.status === 200) {
      add('5b. memory_write stores the note', true, `status ${describe(write)}`);
      const read = await fetched(bothToken, 'memory_read', 'GET', '/v1/note', { query: { path: PROBE_PATH } });
      const content = !('error' in read) && read.status === 200 ? (read.body as any)?.content : undefined;
      // memory_read returns the whole file, front matter included.
      const readContent =
        typeof content === 'string' &&
        content.includes(probeNote.content.trim()) &&
        content.includes(`name: ${PROBE_NAME}`) &&
        content.includes(probeNote.description);
      add('5b. memory_read returns the note', readContent, `status ${describe(read)}, content ${readContent ? 'matches' : 'differs'}`);
      const index = await fetched(bothToken, 'memory_index', 'GET', '/v1/index', { query: { scope: `agents/${PROBE_AGENT}` } });
      const indexed = !('error' in index) && index.status === 200 && String((index.body as any)?.index ?? '').includes(PROBE_NAME);
      add('5b. memory_index lists the note', indexed, `status ${describe(index)}, ${indexed ? 'listed' : 'not listed'}`);
      const scopes = await fetched(bothToken, 'memory_scopes', 'GET', '/v1/scopes', {});
      const listed = !('error' in scopes) && scopes.status === 200 && ((scopes.body as any)?.scopes ?? []).some((s: any) => s?.scope === `agents/${PROBE_AGENT}`);
      add('5b. memory_scopes includes the agent scope', listed, `status ${describe(scopes)}, ${listed ? 'included' : 'missing'}`);
    } else {
      // Only a full scope or a full store is an expected refusal; anything else is a failure.
      const code = !('error' in write) && write.status === 400 ? (write.body as any)?.error?.code : undefined;
      if (code === 'scope_full' || code === 'store_full') {
        add('5b. write and read back a note', true, `SKIP: memory_write answered 400 ${code}`, true);
      } else {
        const shown = typeof code === 'string' && /^[a-z_]{1,30}$/.test(code) ? ` ${code}` : '';
        add('5b. memory_write stores the note', false, `memory_write answered ${describe(write)}${shown}, expect 200`);
      }
    }
  }

  progress.step = 'check 6';
  // Check 6: every response that was received has the documented fields.
  const missing: string[] = [];
  const checked: string[] = [];
  for (const route of ROUTES) {
    const reply = replies.get(route.operationId);
    if (reply === undefined || reply.status !== 200) continue;
    checked.push(route.operationId);
    const body = reply.body;
    const fields = requiredFields(openapi, route.method, route.path);
    if (fields === null) missing.push(`${route.operationId} (no required list in openapi.json)`);
    for (const field of fields ?? []) {
      if (typeof body !== 'object' || body === null || !(field in body)) missing.push(`${route.operationId}.${field}`);
    }
  }
  const notChecked = ROUTES.map((r) => r.operationId).filter((id) => !checked.includes(id));
  add(
    '6. responses have the documented fields',
    missing.length === 0 && checked.length > 0,
    missing.length > 0 ? `missing: ${missing.join(', ')}` : `checked: ${checked.join(', ')}${notChecked.length > 0 ? `; not checked: ${notChecked.join(', ')}` : ''}`,
  );

  // Check 7
  progress.step = 'check 7';
  const unknown = await call('GET', '/v1/nope', { token: readToken });
  add('7. an unknown path is not served', !('error' in unknown) && (unknown.status === 404 || unknown.status === 401), `GET /v1/nope: ${describe(unknown)}, expect 404 or 401`);

  // Check 8
  progress.step = 'check 8';
  if (expiryToken !== undefined) {
    const expiry = tokenExpiry(expiryToken);
    if (expiry === null) {
      add('8. an expired token is refused', false, 'the probe token has no readable expiry');
    } else {
      while (now() < expiry + EXPIRY_MARGIN_MS) {
        await sleep(Math.min(SLEEP_STEP_MS, expiry + EXPIRY_MARGIN_MS - now()));
      }
      const late = await call('GET', '/v1/scopes', { token: expiryToken });
      add('8. an expired token is refused', !('error' in late) && late.status === 401, `GET /v1/scopes after expiry: ${describe(late)}, expect 401`);
    }
  }

  return results;
}

// ---- command line ----

function parseArgs(argv: string[]): { stage: string; region?: string; expired: boolean } {
  let stage: string | undefined;
  let region: string | undefined;
  let expired = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--stage') stage = argv[++i];
    else if (arg === '--region') region = argv[++i];
    else if (arg === '--expired') expired = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (stage === undefined || !/^[A-Za-z0-9-]+$/.test(stage)) {
    throw new Error('Usage: verify-deployed.ts --stage <stage> [--region <region>] [--expired]');
  }
  return { stage, region, expired };
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : 'bad arguments');
    return 2;
  }
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const ssm = new SSMClient(args.region === undefined ? {} : { region: args.region });
  const prefix = `/agent-memory/${args.stage}/mcp`;
  const read = async (key: string): Promise<string> => {
    const out = await ssm.send(new GetParameterCommand({ Name: `${prefix}/${key}`, WithDecryption: true }));
    if (out.Parameter?.Value === undefined) throw new Error(`parameter ${key} has no value`);
    return out.Parameter.Value;
  };
  let config: Config;
  let clientId: string;
  let clientSecret: string;
  try {
    config = { apiUrl: await read('gateway/url'), tokenEndpoint: await read('cognito/token-endpoint') };
    clientId = await read('cognito/probe/client-id');
    clientSecret = await read('cognito/probe/client-secret');
  } catch (err) {
    console.error(`Could not read the stage parameters (${err instanceof Error ? err.name : 'error'}).`);
    return 2;
  }

  const mintToken = makeMintToken({ fetch: (input, init) => fetch(input, init), tokenEndpoint: config.tokenEndpoint, clientId, clientSecret });

  try {
    const results = await runChecks({
      fetch: (input, init) => fetch(input, init),
      config,
      mintToken,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      expired: args.expired,
      stage: args.stage,
      onResult: (r) => console.log(formatResult(r)),
    });
    return results.some((r) => !r.ok) ? 1 : 0;
  } catch (err) {
    // The results so far were printed as they were produced. Only the step and the error class.
    console.error(`FAIL  ${err instanceof ChecksStoppedError ? err.message : 'checks stopped'}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
