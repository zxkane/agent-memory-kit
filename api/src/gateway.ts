import { ApiError } from './errors.ts';
import { failure, runOperation, writeLine } from './run.ts';
import type { Line, Operations, Query } from './run.ts';
import { ROUTES } from './routes.ts';

// A gateway that invokes the function directly (a Lambda target) sends the tool's arguments as the
// event and names the tool in the client context, which only the caller of the Lambda Invoke API
// can set. The same operations and validation as the HTTP path run behind both entries.

export type GatewayContext = { clientContext?: { custom?: Record<string, unknown> } };

const TOOL_NAME_KEY = 'bedrockAgentCoreToolName';
const ID_RE = /^[A-Za-z0-9-]{1,100}$/;
const READ_TOOLS = ['memory_scopes', 'memory_index', 'memory_search', 'memory_read'];

export function isGatewayInvocation(context: GatewayContext | undefined): context is GatewayContext {
  return typeof context?.clientContext?.custom?.[TOOL_NAME_KEY] === 'string';
}

/** The tool is the text after the first three underscores of "<target>___<tool>"; null if it is none of ours. */
function toolOf(context: GatewayContext): string | null {
  const full = context.clientContext!.custom![TOOL_NAME_KEY] as string;
  const cut = full.indexOf('___');
  const tool = cut < 0 ? '' : full.slice(cut + 3);
  return ROUTES.some((r) => r.operationId === tool) ? tool : null;
}

function idOf(context: GatewayContext, key: string): string | null {
  const value = context.clientContext?.custom?.[key];
  return typeof value === 'string' && ID_RE.test(value) ? value : null;
}

function invalid(message: string): ApiError {
  return new ApiError(400, 'invalid_request', message);
}

/** The query string parameters the HTTP route would have received for these arguments. */
function toQuery(args: Record<string, unknown>): Query {
  const query: Query = {};
  for (const [key, value] of Object.entries(args)) {
    // defineProperty, so that a key such as __proto__ stays an own property and is refused as unknown.
    const set = (text: string) => Object.defineProperty(query, key, { value: text, enumerable: true, writable: true, configurable: true });
    if (typeof value === 'string') set(value);
    else if (key === 'limit' && typeof value === 'number' && Number.isInteger(value)) set(String(value));
    else throw invalid('Every argument must be a string; limit may also be an integer.');
  }
  return query;
}

export async function handleGateway(
  deps: { ops: Operations; log: (line: object) => void; direct: boolean },
  event: unknown,
  context: GatewayContext,
): Promise<unknown> {
  const started = Date.now();
  const tool = toolOf(context);
  const line: Line = {
    op: tool,
    clientId: null,
    scope: null,
    path: null,
    status: 200,
    ms: 0,
    via: 'gateway',
    gateway: idOf(context, 'bedrockAgentCoreGatewayId'),
    target: idOf(context, 'bedrockAgentCoreTargetId'),
  };
  let query: Query = {};
  let body: unknown;
  let answer: unknown;
  try {
    // Refused before anything of the event is looked at.
    if (!deps.direct) throw new ApiError(403, 'forbidden', 'direct invocation is not enabled');
    if (tool === null) throw new ApiError(404, 'not_found', 'unknown tool');
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      throw invalid('The arguments must be a JSON object.');
    }
    const args = event as Record<string, unknown>;
    if (tool === 'memory_write') body = args;
    else if (READ_TOOLS.includes(tool)) query = toQuery(args);
    answer = await runOperation(deps.ops, tool, query, () => body);
  } catch (err) {
    answer = failure(err, line).body;
  }
  writeLine(deps.log, line, started, query, body);
  return answer;
}

