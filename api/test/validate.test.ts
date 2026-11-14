import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/errors.ts';
import { ROUTES, RESOURCE_SERVER } from '../src/routes.ts';
import {
  onlyParams,
  parseLimit,
  parseNotePath,
  parseQuery,
  parseScope,
  parseWrite,
  scopeKeyPrefix,
  scopeName,
} from '../src/validate.ts';

const MARKER = 'zzmarker';

function rejects(fn: () => unknown, marker: string = MARKER): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    assert.equal(err.code, 'invalid_request');
    assert.ok(err.message.length > 0);
    assert.ok(!err.message.includes(marker), `message echoes value: ${err.message}`);
    return true;
  });
}

const validBody = () => ({ agent: 'hermes', name: 'my-note', description: 'A note', content: 'Body' });

test('route table and resource server', () => {
  assert.equal(RESOURCE_SERVER, 'agent-memory');
  assert.deepEqual(
    ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId} ${r.scope}`),
    [
      'GET /v1/scopes memory_scopes read',
      'GET /v1/index memory_index read',
      'GET /v1/search memory_search read',
      'GET /v1/note memory_read read',
      'POST /v1/notes memory_write write',
    ],
  );
});

test('ApiError carries status, code and message', () => {
  const e = new ApiError(404, 'not_found', 'No such note.');
  assert.ok(e instanceof Error);
  assert.deepEqual([e.status, e.code, e.message], [404, 'not_found', 'No such note.']);
});

test('parseScope accepts the three scope forms', () => {
  assert.deepEqual(parseScope('global'), { kind: 'global' });
  assert.deepEqual(parseScope('projects/my.proj-1'), { kind: 'project', project: 'my.proj-1' });
  assert.deepEqual(parseScope('agents/hermes-2'), { kind: 'agent', agent: 'hermes-2' });
});

test('parseScope rejects malformed scopes', () => {
  for (const bad of ['', 'projects/', 'projects/a/b', 'projects/..', 'projects/.', 'agents/Hermes', 'agents/a_b', 'global/', '/global', `projects/${MARKER}%`, `${MARKER}`]) {
    rejects(() => parseScope(bad));
  }
  for (const bad of [undefined, null, 5, {}, ['global']]) {
    rejects(() => parseScope(bad));
  }
});

test('scopeKeyPrefix and scopeName', () => {
  const g = parseScope('global');
  const p = parseScope('projects/foo');
  const a = parseScope('agents/bar');
  assert.equal(scopeKeyPrefix(g), 'mem/global/');
  assert.equal(scopeKeyPrefix(p), 'mem/projects/foo/');
  assert.equal(scopeKeyPrefix(a), 'agents/bar/');
  assert.equal(scopeName(g), 'global');
  assert.equal(scopeName(p), 'projects/foo');
  assert.equal(scopeName(a), 'agents/bar');
});

test('parseNotePath accepts scope/file', () => {
  assert.deepEqual(parseNotePath('global/MEMORY.md'), { scope: { kind: 'global' }, file: 'MEMORY.md' });
  assert.deepEqual(parseNotePath('projects/p/a.b-c_d.md'), { scope: { kind: 'project', project: 'p' }, file: 'a.b-c_d.md' });
  assert.deepEqual(parseNotePath('agents/x/note.md'), { scope: { kind: 'agent', agent: 'x' }, file: 'note.md' });
});

test('parseNotePath rejects traversal and malformed paths', () => {
  for (const bad of [
    'global/../x.md',
    'projects/a/../../agents/b/c.md',
    'global/a.txt',
    'global/.a.md',
    'agents/x/sub/a.md',
    'global/a.md/',
    '%2e%2e/a.md',
    '',
    'global',
    'global/',
    `global/${MARKER}.txt`,
  ]) {
    rejects(() => parseNotePath(bad));
  }
  rejects(() => parseNotePath(42));
  rejects(() => parseNotePath(undefined));
});

test('parseLimit', () => {
  assert.equal(parseLimit(undefined), 10);
  assert.equal(parseLimit('1'), 1);
  assert.equal(parseLimit('20'), 20);
  for (const bad of ['0', '21', '1.5', 'abc', '', '-1', `${MARKER}`]) {
    rejects(() => parseLimit(bad));
  }
});

test('parseQuery', () => {
  assert.deepEqual(parseQuery('  Hello   World '), ['hello', 'world']);
  assert.deepEqual(parseQuery('a bb a bb ccc'), ['bb', 'ccc']);
  assert.deepEqual(parseQuery('BB bb'), ['bb']);
  assert.deepEqual(parseQuery('t1 t2 t3 t4 t5 t6 t7 t8 t9 t10'), ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
  assert.deepEqual(parseQuery('x 记忆'), ['记忆']);
  assert.equal(parseQuery('a'.repeat(200)).length, 1);
  rejects(() => parseQuery(''));
  rejects(() => parseQuery('   '));
  rejects(() => parseQuery(undefined));
  rejects(() => parseQuery(MARKER + 'a'.repeat(200 - MARKER.length + 1)));
  rejects(() => parseQuery('a b c'), 'a b c');
  rejects(() => parseQuery(7));
});

test('parseWrite accepts a valid body and applies defaults', () => {
  assert.deepEqual(parseWrite(validBody()), {
    agent: 'hermes',
    name: 'my-note',
    description: 'A note',
    type: 'reference',
    content: 'Body',
  });
  const full = parseWrite({ ...validBody(), type: 'feedback', description: '  padded  ' });
  assert.equal(full.type, 'feedback');
  assert.equal(full.description, 'padded');
  for (const type of ['user', 'feedback', 'project', 'reference']) {
    assert.equal(parseWrite({ ...validBody(), type }).type, type);
  }
});

test('parseWrite measures content in UTF-8 bytes', () => {
  assert.equal(parseWrite({ ...validBody(), content: 'a'.repeat(50000) }).content.length, 50000);
  // 3 bytes per character: 16,666 chars = 49,998 bytes (ok); 16,667 = 50,001 bytes (too big)
  parseWrite({ ...validBody(), content: '记'.repeat(16666) });
  rejects(() => parseWrite({ ...validBody(), content: '记'.repeat(16667) }));
  rejects(() => parseWrite({ ...validBody(), content: 'a'.repeat(50001) }));
  rejects(() => parseWrite({ ...validBody(), content: '' }));
});

test('parseWrite rejects invalid bodies without echoing values', () => {
  const bad: unknown[] = [
    { ...validBody(), [MARKER]: 1 },
    (({ content: _c, ...rest }) => rest)(validBody()),
    { ...validBody(), name: 'memory' },
    { ...validBody(), name: 'A' },
    { ...validBody(), name: MARKER + '_' },
    { ...validBody(), agent: MARKER.toUpperCase() },
    { ...validBody(), description: `${MARKER}\nsecond line` },
    { ...validBody(), description: `${MARKER}\rx` },
    { ...validBody(), description: 'd'.repeat(301) },
    { ...validBody(), description: '   ' },
    { ...validBody(), type: 'other' },
    { ...validBody(), type: MARKER },
    { ...validBody(), content: 5 },
    null,
    undefined,
    'string',
    42,
    [validBody()],
  ];
  for (const b of bad) rejects(() => parseWrite(b));
  parseWrite({ ...validBody(), description: 'd'.repeat(300) });
});

test('parseWrite rejects control and line-separator characters in the description', () => {
  for (const ch of ['\t', '\u0085', '\u2028', '\u2029', '\u0000', '\u001f', '\u007f']) {
    rejects(() => parseWrite({ ...validBody(), description: `a${ch}b` }));
    rejects(() => parseWrite({ ...validBody(), description: `${MARKER}${ch}` }));
  }
});

test('onlyParams rejects unknown parameters', () => {
  onlyParams({}, ['scope']);
  onlyParams({ scope: 'global', limit: undefined }, ['scope', 'limit']);
  rejects(() => onlyParams({ scope: 'global', [MARKER]: '1' }, ['scope']));
});

test('parseQuery folds case without changing string length', () => {
  assert.deepEqual(parseQuery('İSTANBUL Kiwi'), ['İstanbul', 'kiwi']);
});
