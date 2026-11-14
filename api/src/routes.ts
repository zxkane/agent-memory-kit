export const RESOURCE_SERVER = 'agent-memory';

export const ROUTES = [
  { method: 'GET', path: '/v1/scopes', operationId: 'memory_scopes', scope: 'read' },
  { method: 'GET', path: '/v1/index', operationId: 'memory_index', scope: 'read' },
  { method: 'GET', path: '/v1/search', operationId: 'memory_search', scope: 'read' },
  { method: 'GET', path: '/v1/note', operationId: 'memory_read', scope: 'read' },
  { method: 'POST', path: '/v1/notes', operationId: 'memory_write', scope: 'write' },
] as const;
