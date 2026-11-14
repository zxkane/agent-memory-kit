import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiError } from './errors.ts';
import { memoryIndex } from './ops/index.ts';
import { memoryRead } from './ops/read.ts';
import { memoryScopes } from './ops/scopes.ts';
import { memorySearch } from './ops/search.ts';
import { memoryWrite } from './ops/write.ts';
import { ROUTES } from './routes.ts';
import { createSnapshots } from './snapshot.ts';
import { s3Store } from './store.ts';
import type { Store } from './store.ts';
import { parseNotePath, parseScope, scopeName } from './validate.ts';

const MAX_BODY_BYTES = 100_000;

type Query = Record<string, string | undefined>;
type Line = { op: string | null; clientId: string | null; scope: string | null; path: string | null; status: number; ms: number; error?: string };
type Handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyStructuredResultV2>;

function reply(status: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function parseBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): unknown {
  const bad = () => new ApiError(400, 'invalid_request', 'The request body must be a JSON object of at most 100000 bytes.');
  if (typeof event.body !== 'string' || event.body === '') throw bad();
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8');
  if (raw.length > MAX_BODY_BYTES) throw bad();
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw bad();
  }
}

// Scope and path for the log line: only values that pass the same validation as the operations.
function logTargets(operationId: string | null, query: Query, body: unknown): { scope: string | null; path: string | null } {
  let scope: string | null = null;
  let path: string | null = null;
  try {
    if (query.scope !== undefined) scope = scopeName(parseScope(query.scope));
    if (operationId === 'memory_read') {
      const note = parseNotePath(query.path);
      scope = scopeName(note.scope);
      path = `${scope}/${note.file}`;
    }
    if (operationId === 'memory_write' && typeof body === 'object' && body !== null) {
      const { agent, name } = body as Record<string, unknown>;
      scope = scopeName(parseScope(`agents/${String(agent)}`));
      const note = parseNotePath(`${scope}/${String(name)}.md`);
      path = `${scopeName(note.scope)}/${note.file}`;
    }
  } catch {
    // Invalid input is simply not logged.
  }
  return { scope, path };
}

export function createHandler(deps: { store: Store; log?: (line: object) => void }): Handler {
  const log = deps.log ?? ((line: object) => console.log(JSON.stringify(line)));
  const snapshots = createSnapshots(deps.store);

  return async (event) => {
    const started = Date.now();
    const route = ROUTES.find((r) => `${r.method} ${r.path}` === event.routeKey);
    const query: Query = event.queryStringParameters ?? {};
    const claim = (event.requestContext?.authorizer?.jwt?.claims as Record<string, unknown> | undefined)?.client_id;
    const line: Line = {
      op: route?.operationId ?? null,
      clientId: typeof claim === 'string' ? claim : null,
      scope: null,
      path: null,
      status: 200,
      ms: 0,
    };
    let body: unknown;
    let response: APIGatewayProxyStructuredResultV2;
    try {
      if (!route) throw new ApiError(404, 'not_found', 'unknown route');
      let result: unknown;
      switch (route.operationId) {
        case 'memory_scopes':
          result = await memoryScopes({ snapshots });
          break;
        case 'memory_index':
          result = await memoryIndex({ store: deps.store }, query);
          break;
        case 'memory_search':
          result = await memorySearch({ snapshots }, query);
          break;
        case 'memory_read':
          result = await memoryRead({ store: deps.store }, query);
          break;
        case 'memory_write':
          body = parseBody(event);
          result = await memoryWrite({ store: deps.store }, body);
          break;
      }
      response = reply(200, result);
    } catch (err) {
      if (err instanceof ApiError) {
        line.status = err.status;
        response = reply(err.status, errorBody(err.code, err.message));
      } else {
        line.status = 500;
        line.error = err instanceof Error ? err.name : 'unknown';
        response = reply(500, errorBody('internal', 'internal error'));
      }
    }
    Object.assign(line, logTargets(line.op, query, body));
    line.ms = Date.now() - started;
    log(line);
    return response;
  };
}

// Built on first use, so importing this module needs neither the BUCKET variable nor AWS.
let shared: Handler | undefined;

export const handler: Handler = (event) => {
  shared ??= createHandler({ store: s3Store(process.env.BUCKET!) });
  return shared(event);
};
