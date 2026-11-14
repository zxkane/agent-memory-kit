import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ApiError } from './errors.ts';
import { handleGateway, isGatewayInvocation, isObject } from './gateway.ts';
import type { GatewayContext } from './gateway.ts';
import { MAX_BODY_BYTES, failure, runOperation, writeLine } from './run.ts';
import type { Line, Query } from './run.ts';
import { RESOURCE_SERVER, ROUTES } from './routes.ts';
import { createSnapshots } from './snapshot.ts';
import { s3Store } from './store.ts';
import type { Store } from './store.ts';

type HttpHandler = (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyStructuredResultV2>;
// The first signature is the HTTP API event; the second is what Lambda passes in general, which
// may be a gateway invocation (answered with a plain object).
type Handler = HttpHandler & ((event: unknown, context?: GatewayContext) => Promise<unknown>);

function reply(status: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function parseBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): unknown {
  const bad = () => new ApiError(400, 'invalid_request', 'The request body must be a JSON object.');
  if (typeof event.body !== 'string' || event.body === '') throw bad();
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body, 'utf8');
  if (raw.length > MAX_BODY_BYTES) throw new ApiError(400, 'invalid_request', 'the request body is too large');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw bad();
  }
}

export function createHandler(deps: { store: Store; log?: (line: object) => void; direct?: boolean }): Handler {
  const log = deps.log ?? ((line: object) => console.log(JSON.stringify(line)));
  const ops = { store: deps.store, snapshots: createSnapshots(deps.store) };

  const http: HttpHandler = async (event) => {
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
      // API Gateway enforces the scope per route; this makes the function fail closed if a route
      // is ever deployed without it. It does not verify the token itself.
      const scopes = (event.requestContext?.authorizer?.jwt?.claims as Record<string, unknown> | undefined)?.scope;
      const granted = typeof scopes === 'string' ? scopes.split(/\s+/) : [];
      if (!granted.includes(`${RESOURCE_SERVER}/${route.scope}`)) {
        throw new ApiError(403, 'forbidden', 'the token does not allow this operation');
      }
      const result = await runOperation(ops, route.operationId, query, () => (body = parseBody(event)));
      response = reply(200, result);
    } catch (err) {
      const failed = failure(err, line);
      response = reply(failed.status, failed.body);
    }
    writeLine(log, line, started, query, body);
    return response;
  };

  // Only the platform's context can say that this is a gateway invocation; an HTTP API event
  // carries no such context, and nothing inside an event can make it take the direct path.
  return ((event: unknown, context?: GatewayContext) =>
    isGatewayInvocation(context)
      ? handleGateway({ ops, log, direct: deps.direct === true }, event, context)
      : http((isObject(event) ? event : {}) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer)) as Handler;
}

// Built on first use, so importing this module needs neither the BUCKET variable nor AWS.
let shared: Handler | undefined;

export const handler = ((event: unknown, context?: GatewayContext) => {
  shared ??= createHandler({ store: s3Store(process.env.BUCKET!), direct: process.env.DIRECT_INVOCATION === 'on' });
  return shared(event, context);
}) as Handler;
