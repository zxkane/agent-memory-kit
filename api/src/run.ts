import { scanText } from '../../workstation/lib/secret-scan.mjs';
import { ApiError } from './errors.ts';
import { memoryIndex } from './ops/index.ts';
import { memoryRead } from './ops/read.ts';
import { memoryScopes } from './ops/scopes.ts';
import { memorySearch } from './ops/search.ts';
import { memoryWrite } from './ops/write.ts';
import type { createSnapshots } from './snapshot.ts';
import type { Store } from './store.ts';
import { onlyParams, parseNotePath, parseScope, scopeName } from './validate.ts';

// What both entry points (HTTP API event, gateway invocation) share: running one operation, the
// error answer, and the log line.

export type Query = Record<string, string | undefined>;
export type Line = {
  op: string | null;
  clientId: string | null;
  scope: string | null;
  path: string | null;
  status: number;
  ms: number;
  error?: string;
  via?: 'gateway';
  gateway?: string | null;
  target?: string | null;
};
export type Operations = { store: Store; snapshots: ReturnType<typeof createSnapshots> };
export type ErrorAnswer = { error: { code: string; message: string } };

export function errorBody(code: string, message: string): ErrorAnswer {
  return { error: { code, message } };
}

/** Runs one operation. readBody is called only for memory_write, after the query was checked. */
export async function runOperation(
  ops: Operations,
  operationId: string,
  query: Query,
  readBody: () => unknown,
): Promise<unknown> {
  switch (operationId) {
    case 'memory_scopes':
      onlyParams(query, []);
      return memoryScopes({ snapshots: ops.snapshots });
    case 'memory_index':
      return memoryIndex({ store: ops.store }, query);
    case 'memory_search':
      return memorySearch({ snapshots: ops.snapshots }, query);
    case 'memory_read':
      return memoryRead({ store: ops.store }, query);
    case 'memory_write':
      onlyParams(query, []);
      return memoryWrite({ store: ops.store }, readBody());
    default:
      throw new ApiError(404, 'not_found', 'unknown route');
  }
}

/** The status and answer for a failed operation; records the status (and for a bug the error name) in the line. */
export function failure(err: unknown, line: Line): { status: number; body: ErrorAnswer } {
  if (err instanceof ApiError) {
    line.status = err.status;
    return { status: err.status, body: errorBody(err.code, err.message) };
  }
  line.status = 500;
  line.error = err instanceof Error ? err.name : 'unknown';
  return { status: 500, body: errorBody('internal', 'internal error') };
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
  // A value the credential scan flags is not logged either, whichever route it came in on.
  const flagged = (value: string | null) => value !== null && (scanText(value) as unknown[]).length > 0;
  if (flagged(scope) || flagged(path)) return { scope: null, path: null };
  return { scope, path };
}

/** Completes the line (validated scope and path, duration) and writes it. */
export function writeLine(
  log: (line: object) => void,
  line: Line,
  started: number,
  query: Query,
  body: unknown,
): void {
  Object.assign(line, logTargets(line.op, query, body));
  line.ms = Date.now() - started;
  log(line);
}
