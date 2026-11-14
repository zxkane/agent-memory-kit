import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { S3Client } from '@aws-sdk/client-s3';
import { ApiError } from '../src/errors.ts';
import { s3Store, update } from '../src/store.ts';
import { fakeStore } from './fake-store.ts';

test('fake store: etag changes on write', async () => {
  const s = fakeStore();
  const a = await s.put('k', 'one', null);
  const b = await s.put('k', 'two', null);
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');
  assert.notEqual((a as { etag: string }).etag, (b as { etag: string }).etag);
});

test('fake store: ifNoneMatch * fails when present, ifMatch fails when stale', async () => {
  const s = fakeStore({ k: 'one' });
  assert.deepEqual(await s.put('k', 'x', { ifNoneMatch: '*' }), { status: 'precondition-failed' });
  assert.deepEqual(await s.put('k', 'x', { ifMatch: '"stale"' }), { status: 'precondition-failed' });
  assert.deepEqual(await s.put('new', 'x', { ifMatch: '"any"' }), { status: 'precondition-failed' });
  assert.equal((await s.put('new', 'x', { ifNoneMatch: '*' })).status, 'ok');
});

test('fake store: get with current etag is not-modified', async () => {
  const s = fakeStore({ k: 'one' });
  const first = await s.get('k');
  assert.equal(first.status, 'ok');
  assert.deepEqual(await s.get('k', (first as { etag: string }).etag), { status: 'not-modified' });
  assert.equal((await s.get('k', '"other"')).status, 'ok');
  assert.deepEqual(await s.get('nope'), { status: 'missing' });
});

test('update: writes new key with ifNoneMatch *', async () => {
  const s = fakeStore();
  await update(s, 'k', (cur) => `${cur ?? 'none'}!`);
  assert.equal(s.objects.get('k')?.body, 'none!');
});

test('update: retries after one competing write', async () => {
  const s = fakeStore({ k: 'a' });
  let injected = false;
  s.beforePut = (key) => {
    if (injected) return;
    injected = true;
    s.objects.set(key, { body: 'b', etag: '"competing"' });
  };
  await update(s, 'k', (cur) => `${cur}+`);
  assert.equal(s.objects.get('k')?.body, 'b+');
});

test('update: throws 409 conflict after five attempts', async () => {
  const s = fakeStore({ k: 'a' });
  let n = 0;
  s.beforePut = (key) => {
    s.objects.set(key, { body: 'c', etag: `"c${++n}"` });
  };
  await assert.rejects(
    () => update(s, 'k', (cur) => `${cur}+`),
    (err: unknown) => err instanceof ApiError && err.status === 409 && err.code === 'conflict',
  );
  assert.equal(n, 5);
});

// ---- s3Store against a stub client ----

type Sent = { name: string; input: Record<string, unknown> };

function stubClient(handler: (cmd: Sent) => unknown): { client: S3Client; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const cmd = { name: command.constructor.name, input: command.input };
      sent.push(cmd);
      return handler(cmd);
    },
  } as unknown as S3Client;
  return { client, sent };
}

function awsError(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

function body(text: string | Uint8Array) {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return { transformToByteArray: async () => bytes };
}

test('s3Store.get returns body and etag', async () => {
  const { client, sent } = stubClient(() => ({ Body: body('héllo'), ETag: '"e1"' }));
  const out = await s3Store('bkt', client).get('mem/global/a.md', '"old"');
  assert.deepEqual(out, { status: 'ok', body: 'héllo', etag: '"e1"' });
  assert.equal(sent[0]?.name, 'GetObjectCommand');
  assert.deepEqual(sent[0]?.input, { Bucket: 'bkt', Key: 'mem/global/a.md', IfNoneMatch: '"old"' });
});

test('s3Store.get maps NoSuchKey/404 to missing and 304 to not-modified', async () => {
  const a = stubClient(() => {
    throw awsError('NoSuchKey', 404);
  });
  assert.deepEqual(await s3Store('b', a.client).get('k'), { status: 'missing' });
  const b = stubClient(() => {
    throw awsError('NotModified', 304);
  });
  assert.deepEqual(await s3Store('b', b.client).get('k', '"e"'), { status: 'not-modified' });
});

test('s3Store.get reads AccessDenied/403 as missing, NoSuchBucket as an error, and put rethrows AccessDenied', async () => {
  const denied = stubClient(() => {
    throw awsError('AccessDenied', 403);
  });
  assert.deepEqual(await s3Store('b', denied.client).get('k'), { status: 'missing' });
  const absent = stubClient(() => {
    throw awsError('NoSuchKey', 404);
  });
  assert.deepEqual(await s3Store('b', absent.client).get('k'), { status: 'missing' });
  const bucket = stubClient(() => {
    throw awsError('NoSuchBucket', 404);
  });
  await assert.rejects(() => s3Store('b', bucket.client).get('k'), /NoSuchBucket/);
  const put = stubClient(() => {
    throw awsError('AccessDenied', 403);
  });
  await assert.rejects(() => s3Store('b', put.client).put('k', 'x', null), /AccessDenied/);
});

test('s3Store.get rethrows other errors and rejects bodies over 8 MB', async () => {
  const nb = stubClient(() => {
    throw awsError('NoSuchBucket', 404);
  });
  await assert.rejects(() => s3Store('b', nb.client).get('k'), /NoSuchBucket/);
  const b = stubClient(() => ({ Body: body(new Uint8Array(8 * 1024 * 1024 + 1)), ETag: '"e"' }));
  await assert.rejects(() => s3Store('b', b.client).get('k'));
  const c = stubClient(() => ({ Body: body('x'), ContentLength: 8 * 1024 * 1024 + 1, ETag: '"e"' }));
  await assert.rejects(() => s3Store('b', c.client).get('k'));
});

test('s3Store.put sends conditions and content types', async () => {
  const { client, sent } = stubClient(() => ({ ETag: '"n"' }));
  const s = s3Store('bkt', client);
  assert.deepEqual(await s.put('agents/a/x.md', 'text', { ifNoneMatch: '*' }), { status: 'ok', etag: '"n"' });
  await s.put('index/agents.json', '{}', { ifMatch: '"m"' });
  await s.put('index/other.json', '{}', null);
  assert.equal(sent[0]?.name, 'PutObjectCommand');
  assert.deepEqual(sent[0]?.input, {
    Bucket: 'bkt',
    Key: 'agents/a/x.md',
    Body: 'text',
    ContentType: 'text/markdown; charset=utf-8',
    IfNoneMatch: '*',
  });
  assert.deepEqual(sent[1]?.input, {
    Bucket: 'bkt',
    Key: 'index/agents.json',
    Body: '{}',
    ContentType: 'application/json',
    IfMatch: '"m"',
  });
  assert.deepEqual(sent[2]?.input, {
    Bucket: 'bkt',
    Key: 'index/other.json',
    Body: '{}',
    ContentType: 'application/json',
  });
});

test('s3Store.put maps 412 and 409 to precondition-failed, rethrows others', async () => {
  for (const [name, status] of [
    ['PreconditionFailed', 412],
    ['ConditionalRequestConflict', 409],
  ] as const) {
    const { client } = stubClient(() => {
      throw awsError(name, status);
    });
    assert.deepEqual(await s3Store('b', client).put('k.md', 'x', { ifNoneMatch: '*' }), {
      status: 'precondition-failed',
    });
  }
  const { client } = stubClient(() => {
    throw awsError('InternalError', 500);
  });
  await assert.rejects(() => s3Store('b', client).put('k.md', 'x', null), /InternalError/);
});

test('update: an error thrown by change reaches the caller unchanged and writes nothing', async () => {
  const s = fakeStore({ k: 'a' });
  const boom = new ApiError(400, 'scope_full', 'full');
  let puts = 0;
  const put = s.put.bind(s);
  s.put = async (...args) => {
    puts++;
    return put(...args);
  };
  await assert.rejects(
    () =>
      update(s, 'k', () => {
        throw boom;
      }),
    (err: unknown) => err === boom,
  );
  assert.equal(puts, 0);
  assert.equal(s.objects.get('k')?.body, 'a');
});
