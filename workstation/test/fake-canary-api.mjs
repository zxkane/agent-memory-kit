// A fake `fetch` for the canary tests: the instance metadata service, Systems Manager Parameter
// Store, a token endpoint and a memory API that refuses and serves what the deployed checks expect.
// It never reaches a network. Used in-process (as `fetchImpl`) and, through fake-canary-preload.mjs,
// as the `fetch` of a spawned `run.sh canary`.
import { appendFileSync } from 'node:fs';

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const PARAM_KEYS = {
  url: 'gateway/url',
  tokenEndpoint: 'cognito/token-endpoint',
  clientId: 'cognito/probe/client-id',
  clientSecret: 'cognito/probe/client-secret',
};

// Values are built at run time, so that no file holds a literal credential.
export function fakeValues(tag = String(process.pid)) {
  return {
    url: 'https://api.example.com/prod',
    tokenEndpoint: 'https://auth.example.com/oauth2/token',
    clientId: `probe-client-${tag}`,
    clientSecret: ['probe', 'secret', 'marker', tag].join('-'),
  };
}

// scenario: { stage, region, values, deny: [param keys that answer 400 AccessDeniedException],
//   mode: 'ok' | 'open-api' (answers 200 without a token) | 'token-error' (token endpoint 500) | 'hang' (the API never answers),
//   writeScope: true (the token endpoint also issues the write scope; a write is then stored and read back),
//   onWrite: callback with each stored note, imdsDown: true, tokenLog: path that receives every issued token, onToken: callback }
export function makeFakeFetch(scenario) {
  const { stage = 'prod', values = fakeValues(), deny = [], mode = 'ok' } = scenario;
  const valid = new Map(); // token -> scope string
  const notes = new Map();
  let counter = 0;
  const prefix = `/agent-memory/${stage}/mcp/`;
  const byName = new Map(Object.entries(PARAM_KEYS).map(([field, key]) => [prefix + key, field]));

  const hang = (init) => new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (init?.signal?.aborted) fail();
    else init?.signal?.addEventListener('abort', fail, { once: true });
  });

  async function imds(url, init) {
    if (scenario.imdsDown) return new Response('', { status: 404 });
    const method = init?.method ?? 'GET';
    if (method === 'PUT') return new Response('imds-session');
    if (url.pathname.endsWith('/security-credentials/')) return new Response('example-role');
    return json(200, {
      AccessKeyId: 'AKIAEXAMPLE', SecretAccessKey: 'example-signing-value', Token: 'example-session-value',
      Expiration: '2099-01-01T00:00:00Z',
    });
  }

  async function ssm(init) {
    const { Name } = JSON.parse(init.body);
    const field = byName.get(Name);
    if (field === undefined) return json(400, { __type: 'com.amazonaws.ssm#ParameterNotFound' });
    if (deny.includes(PARAM_KEYS[field])) return json(400, { __type: 'com.amazonaws.ssm#AccessDeniedException' });
    return json(200, { Parameter: { Name, Value: values[field] } });
  }

  function mint(init) {
    if (mode === 'token-error') return json(500, { error: 'server_error' });
    const scope = new URLSearchParams(String(init.body)).get('scope') ?? '';
    if (scope.includes('agent-memory/write') && scenario.writeScope !== true) return json(400, { error: 'invalid_scope' });
    counter += 1;
    const token = `eyJhbGciOiJSUzI1NiJ9.${b64({ sub: 'probe', scope, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig${counter}-${process.pid}`;
    valid.set(token, scope);
    scenario.onToken?.(token);
    if (scenario.tokenLog) appendFileSync(scenario.tokenLog, `${token}\n`);
    return json(200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });
  }

  function api(url, init) {
    const header = new Headers(init?.headers).get('authorization');
    if (header === null) return mode === 'open-api' ? json(200, { scopes: [] }) : json(401, { message: 'Unauthorized' });
    if (!valid.has(header.replace(/^Bearer /, ''))) return json(401, { message: 'Unauthorized' });
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/prod/, '');
    const scope = valid.get(header.replace(/^Bearer /, ''));
    if (method === 'POST' && path === '/v1/notes') {
      if (!scope.includes('agent-memory/write')) return json(403, { message: 'Forbidden' });
      const note = JSON.parse(init.body);
      notes.set(`agents/${note.agent}/${note.name}.md`, note);
      scenario.onWrite?.(note);
      return json(200, { path: `agents/${note.agent}/${note.name}.md`, created: true });
    }
    if (path === '/v1/scopes') return json(200, { scopes: [...new Set([...notes.values()].map((n) => `agents/${n.agent}`))].map((s) => ({ scope: s })) });
    if (path === '/v1/search') return json(200, { results: [], total: 0 });
    if (path === '/v1/note') {
      const note = notes.get(url.searchParams.get('path'));
      if (note === undefined) return json(404, { error: { code: 'not_found' } });
      return json(200, { path: url.searchParams.get('path'), content: `---\nname: ${note.name}\ndescription: ${note.description}\n---\n\n${note.content}`, truncated: false });
    }
    if (path === '/v1/index') {
      const wanted = url.searchParams.get('scope');
      const mine = [...notes.values()].filter((n) => `agents/${n.agent}` === wanted);
      if (mine.length === 0) return json(404, { error: { code: 'not_found' } });
      return json(200, { scope: wanted, index: mine.map((n) => `- [${n.name}](${n.name}.md)`).join('\n'), truncated: false });
    }
    return json(404, { message: 'Not Found' });
  }

  return async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === '169.254.169.254') return imds(url, init);
    if (url.hostname.startsWith('ssm.')) return ssm(init);
    if (String(input) === values.tokenEndpoint) return mint(init);
    if (mode === 'hang') return hang(init);
    return api(url, init);
  };
}
