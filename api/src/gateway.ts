import { ApiError } from './errors.ts';
import { MAX_BODY_BYTES, failure, runOperation, writeLine } from './run.ts';
import type { Line, Operations, Query } from './run.ts';
import { ROUTES } from './routes.ts';

// A gateway that invokes the function directly (a Lambda target) sends the tool's arguments as the
// event and names the tool in the client context, which only the caller of the Lambda Invoke API
// can set. The same operations and validation as the HTTP path run behind both entries.

// Depending on how the invoker serialises the client context, the runtime may hand the custom
// values over as custom or as Custom.
export type GatewayContext = { clientContext?: { custom?: Record<string, unknown>; Custom?: Record<string, unknown> } };

const TOOL_NAME_KEY = 'bedrockAgentCoreToolName';
const ID_RE = /^[A-Za-z0-9-]{1,100}$/;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The custom values that name a tool: from custom if it does, else from Custom; undefined if neither does. */
function customOf(context: GatewayContext | undefined): Record<string, unknown> | undefined {
  const client = context?.clientContext;
  return [client?.custom, client?.Custom].find((c) => isObject(c) && typeof c[TOOL_NAME_KEY] === 'string');
}

export function isGatewayInvocation(context: GatewayContext | undefined): context is GatewayContext {
  return customOf(context) !== undefined;
}

/** The tool is the text after the first three underscores of "<target>___<tool>"; null if it is none of ours. */
function toolOf(custom: Record<string, unknown>): string | null {
  const full = custom[TOOL_NAME_KEY] as string;
  const cut = full.indexOf('___');
  const tool = cut < 0 ? '' : full.slice(cut + 3);
  return ROUTES.some((r) => r.operationId === tool) ? tool : null;
}

function idOf(custom: Record<string, unknown>, key: string): string | null {
  const value = custom[key];
  return typeof value === 'string' && ID_RE.test(value) ? value : null;
}

function invalid(message: string): ApiError {
  return new ApiError(400, 'invalid_request', message);
}

/**
 * The query string parameters the HTTP route would have received for these arguments. An argument
 * of another type is left out and reported, so that the log line still has the valid ones.
 */
function toQuery(args: Record<string, unknown>): { query: Query; refused: boolean } {
  const query: Query = {};
  let refused = false;
  for (const [key, value] of Object.entries(args)) {
    // defineProperty, so that a key such as __proto__ stays an own property and is refused as unknown.
    const set = (text: string) => Object.defineProperty(query, key, { value: text, enumerable: true, writable: true, configurable: true });
    if (typeof value === 'string') set(value);
    else if (key === 'limit' && typeof value === 'number' && Number.isInteger(value)) set(String(value));
    else refused = true;
  }
  return { query, refused };
}

export async function handleGateway(
  deps: { ops: Operations; log: (line: object) => void; direct: boolean },
  event: unknown,
  context: GatewayContext,
): Promise<unknown> {
  const started = Date.now();
  const custom = customOf(context)!;
  const tool = toolOf(custom);
  const line: Line = {
    op: tool,
    clientId: null,
    scope: null,
    path: null,
    status: 200,
    ms: 0,
    via: 'gateway',
    gateway: idOf(custom, 'bedrockAgentCoreGatewayId'),
    target: idOf(custom, 'bedrockAgentCoreTargetId'),
  };
  let query: Query = {};
  let body: unknown;
  let answer: unknown;
  try {
    // Refused before anything of the event is looked at.
    if (!deps.direct) throw new ApiError(403, 'forbidden', 'direct invocation is not enabled');
    if (tool === null) throw new ApiError(404, 'not_found', 'unknown tool');
    if (!isObject(event)) throw invalid('The arguments must be a JSON object.');
    if (tool === 'memory_write') {
      if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_BODY_BYTES) {
        throw invalid('the request body is too large');
      }
      body = event;
    } else {
      const converted = toQuery(event);
      query = converted.query;
      if (converted.refused) throw invalid('Every argument must be a string; limit may also be an integer.');
    }
    answer = await runOperation(deps.ops, tool, query, () => body);
  } catch (err) {
    answer = failure(err, line).body;
  }
  writeLine(deps.log, line, started, query, body);
  return answer;
}

