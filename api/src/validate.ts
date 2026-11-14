import { ApiError } from './errors.ts';
import { foldCase } from './text.ts';

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,196}\.md$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

const NOTE_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
const WRITE_KEYS = ['agent', 'name', 'description', 'type', 'content'];

export type Scope = { kind: 'global' } | { kind: 'project'; project: string } | { kind: 'agent'; agent: string };
export type NoteType = (typeof NOTE_TYPES)[number];
export type WriteRequest = {
  agent: string;
  name: string;
  description: string;
  type: NoteType;
  content: string;
};

function invalid(message: string): ApiError {
  return new ApiError(400, 'invalid_request', message);
}

export function parseScope(value: unknown): Scope {
  if (typeof value !== 'string') throw invalid('The scope field must be a string.');
  if (value === 'global') return { kind: 'global' };
  const parts = value.split('/');
  if (parts.length === 2) {
    const [head, name] = parts as [string, string];
    if (head === 'projects' && PROJECT_RE.test(name)) return { kind: 'project', project: name };
    if (head === 'agents' && AGENT_RE.test(name)) return { kind: 'agent', agent: name };
  }
  throw invalid('The scope field must be global, projects/<project> or agents/<agent>.');
}

export function scopeKeyPrefix(scope: Scope): string {
  switch (scope.kind) {
    case 'global':
      return 'mem/global/';
    case 'project':
      return `mem/projects/${scope.project}/`;
    case 'agent':
      return `agents/${scope.agent}/`;
  }
}

export function scopeName(scope: Scope): string {
  switch (scope.kind) {
    case 'global':
      return 'global';
    case 'project':
      return `projects/${scope.project}`;
    case 'agent':
      return `agents/${scope.agent}`;
  }
}

export function parseNotePath(value: unknown): { scope: Scope; file: string } {
  if (typeof value !== 'string') throw invalid('The path field must be a string.');
  const cut = value.lastIndexOf('/');
  const file = value.slice(cut + 1);
  if (cut < 0 || !FILE_RE.test(file)) {
    throw invalid('The path field must be <scope>/<file>.md with a plain file name.');
  }
  return { scope: parseScope(value.slice(0, cut)), file };
}

export function parseLimit(value: unknown): number {
  if (value === undefined) return 10;
  if (typeof value !== 'string' || !/^[0-9]{1,2}$/.test(value)) {
    throw invalid('The limit field must be an integer from 1 to 20.');
  }
  const n = Number(value);
  if (n < 1 || n > 20) throw invalid('The limit field must be an integer from 1 to 20.');
  return n;
}

export function parseQuery(value: unknown): string[] {
  if (typeof value !== 'string') throw invalid('The q field must be a string.');
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw invalid('The q field must be 1 to 200 characters.');
  }
  const terms: string[] = [];
  for (const raw of foldCase(trimmed).split(/\s+/)) {
    if (raw.length === 1 && raw.charCodeAt(0) < 128) continue;
    if (!terms.includes(raw)) terms.push(raw);
    if (terms.length === 8) break;
  }
  if (terms.length === 0) throw invalid('The q field must contain at least one search term of two or more characters.');
  return terms;
}

export function parseWrite(body: unknown): WriteRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid('The request body must be a JSON object.');
  }
  const obj = body as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!WRITE_KEYS.includes(key)) throw invalid('The request body contains an unknown field.');
  }
  const { agent, name, description, type = 'reference', content } = obj;
  if (typeof agent !== 'string' || !AGENT_RE.test(agent)) {
    throw invalid('The agent field must be a lower-case agent name.');
  }
  if (typeof name !== 'string' || !SLUG_RE.test(name) || name === 'memory') {
    throw invalid('The name field must be a lower-case slug other than memory.');
  }
  if (typeof description !== 'string' || /[\r\n]/.test(description)) {
    throw invalid('The description field must be a single line of text.');
  }
  const desc = description.trim();
  if (desc.length < 1 || desc.length > 300) {
    throw invalid('The description field must be 1 to 300 characters.');
  }
  if (typeof type !== 'string' || !(NOTE_TYPES as readonly string[]).includes(type)) {
    throw invalid('The type field must be user, feedback, project or reference.');
  }
  if (typeof content !== 'string') throw invalid('The content field must be a string.');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes < 1 || bytes > 50_000) throw invalid('The content field must be 1 to 50000 bytes.');
  return { agent, name, description: desc, type: type as NoteType, content };
}

export function onlyParams(query: Record<string, string | undefined>, allowed: string[]): void {
  for (const key of Object.keys(query)) {
    if (!allowed.includes(key)) throw invalid('The request contains an unknown query parameter.');
  }
}
