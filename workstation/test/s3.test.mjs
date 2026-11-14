import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AwsError } from '../lib/aws.mjs';
import { createS3 } from '../lib/s3.mjs';
import { createFakeS3 } from './fake-s3.mjs';

const credentials = { accessKeyId: 'EXAMPLEKEYID', secretAccessKey: 'example-signing-value', sessionToken: 'example-session-value' };
const md5 = (s) => `"${createHash('md5').update(s).digest('hex')}"`;

function setup(fakeOpts, s3Opts = {}) {
  const fake = createFakeS3(fakeOpts);
  const sleeps = [];
  const s3 = createS3({
    bucket: 'example-bucket', region: 'ap-northeast-1', credentials, fetchImpl: fake.fetch,
    now: () => new Date('2026-01-02T03:04:05Z'), sleep: async (ms) => { sleeps.push(ms); }, ...s3Opts,
  });
  return { fake, s3, sleeps };
}

test('put then get returns the body and the quoted ETag', async () => {
  const { s3, fake } = setup();
  const put = await s3.put('mem/global/a.md', 'hello', { contentType: 'text/markdown; charset=utf-8' });
  assert.deepEqual(put, { status: 'ok', etag: md5('hello') });
  const got = await s3.get('mem/global/a.md');
  assert.equal(got.status, 'ok');
  assert.equal(got.body.toString(), 'hello');
  assert.equal(got.etag, md5('hello'));
  assert.equal(fake.requests[0].headers['content-type'], 'text/markdown; charset=utf-8');
  assert.match(fake.requests[0].headers.authorization, /^AWS4-HMAC-SHA256 /);
});

test('get of a missing key is missing', async () => {
  const { s3 } = setup();
  assert.deepEqual(await s3.get('nope.md'), { status: 'missing' });
});

test('get: 403 throws, unless deniedIsMissing', async () => {
  const { s3 } = setup(undefined, {
    fetchImpl: async () => new Response('<Error><Code>AccessDenied</Code><Message>SECRET-IN-BODY</Message></Error>', { status: 403 }),
  });
  await assert.rejects(s3.get('a.md'), (err) => {
    assert.ok(err instanceof AwsError);
    assert.equal(err.message, 'get failed: 403 AccessDenied');
    assert.ok(!err.message.includes('SECRET-IN-BODY'));
    return true;
  });
  assert.deepEqual(await s3.get('a.md', { deniedIsMissing: true }), { status: 'missing' });
  assert.deepEqual(await s3.get('a.md', { deniedIsMissing: false }).catch((e) => e.code), 'AccessDenied');
});

test('put with ifNoneMatch * on an existing key is a conflict and changes nothing', async () => {
  const { s3, fake } = setup();
  await s3.put('k.md', 'one');
  assert.deepEqual(await s3.put('k.md', 'two', { ifNoneMatch: '*' }), { status: 'conflict' });
  assert.equal(fake.objects.get('k.md').body.toString(), 'one');
  assert.equal((await s3.put('fresh.md', 'x', { ifNoneMatch: '*' })).status, 'ok');
});

test('put with ifMatch: the current ETag wins, a stale one is a conflict', async () => {
  const { s3, fake } = setup();
  const { etag } = await s3.put('k.md', 'one');
  assert.equal((await s3.put('k.md', 'two', { ifMatch: etag })).status, 'ok');
  assert.deepEqual(await s3.put('k.md', 'three', { ifMatch: etag }), { status: 'conflict' });
  assert.equal(fake.objects.get('k.md').body.toString(), 'two');
});

test('a 409 on put is a conflict', async () => {
  const { s3, fake } = setup();
  fake.failNext(1, 409);
  assert.deepEqual(await s3.put('k.md', 'x'), { status: 'conflict' });
});

test('del removes the object, also when it is already gone', async () => {
  const { s3, fake } = setup();
  await s3.put('k.md', 'one');
  assert.deepEqual(await s3.del('k.md'), { status: 'ok' });
  assert.equal(fake.objects.size, 0);
  assert.deepEqual(await s3.del('k.md'), { status: 'ok' });
});

test('list follows three pages and decodes keys with a space and a plus', async () => {
  const { s3, fake } = setup({ pageSize: 2 });
  const keys = ['agents/a b.md', 'agents/c+d.md', 'agents/e.md', 'agents/f&g.md', 'agents/h.md'];
  // Seeded directly: such keys cannot be written through the client (its paths are restricted).
  for (const k of keys) fake.objects.set(k, { body: Buffer.from(k), etag: md5(k) });
  await s3.put('mem/other.md', 'x');
  const listed = await s3.list('agents/');
  assert.deepEqual(listed.map((o) => o.key).sort(), [...keys].sort());
  assert.equal(listed.find((o) => o.key === 'agents/e.md').etag, md5('agents/e.md'));
  assert.equal(listed.find((o) => o.key === 'agents/e.md').size, 'agents/e.md'.length);
  const pages = fake.requests.filter((r) => r.method === 'GET' && r.key === '');
  assert.equal(pages.length, 3);
  assert.equal(pages[0].query['list-type'], '2');
  assert.equal(pages[0].query['encoding-type'], 'url');
  assert.ok(pages[1].query['continuation-token']);
});

test('a listed ETag equals the ETag put returned', async () => {
  const { s3 } = setup();
  const { etag } = await s3.put('mem/a.md', 'body');
  const [entry] = await s3.list('mem/');
  assert.equal(entry.etag, etag);
});

test('list with more keys than maxKeys throws TooManyKeys', async () => {
  const { s3, fake } = setup({ pageSize: 1000 });
  for (let i = 0; i < 1001; i += 1) fake.objects.set(`k/${i}`, { body: Buffer.from('x'), etag: md5('x') });
  await assert.rejects(s3.list('k/', { maxKeys: 1000 }), { message: 'list failed: 0 TooManyKeys' });
  assert.equal((await s3.list('k/', { maxKeys: 1001 })).length, 1001);
});

test('failNext(2, 503) succeeds on the third attempt, waiting 200 and 400 ms', async () => {
  const { s3, fake, sleeps } = setup();
  fake.objects.set('k.md', { body: Buffer.from('x'), etag: md5('x') });
  fake.failNext(2, 503);
  assert.equal((await s3.get('k.md')).status, 'ok');
  assert.deepEqual(sleeps, [200, 400]);
  assert.equal(fake.requests.length, 3);
});

test('failNext(3, 503) throws with status 503 after three attempts', async () => {
  const { s3, fake } = setup();
  fake.failNext(3, 503);
  await assert.rejects(s3.get('k.md'), (err) => err instanceof AwsError && err.status === 503 && err.code === 'ServiceUnavailable');
  assert.equal(fake.requests.length, 3);
});

test('other statuses are not retried', async () => {
  const { s3, fake } = setup();
  fake.failNext(1, 400);
  await assert.rejects(s3.get('k.md'), { status: 400 });
  assert.equal(fake.requests.length, 1);
});

test('a network error is retried and then reported without the fetch message', async () => {
  let calls = 0;
  const { s3 } = setup(undefined, {
    fetchImpl: async () => { calls += 1; throw new Error('getaddrinfo ENOTFOUND example-bucket.s3.ap-northeast-1.amazonaws.com'); },
  });
  await assert.rejects(s3.get('k.md'), (err) => err.message === 'get failed: 0 Network');
  assert.equal(calls, 3);
});

test('a request that never answers ends as a TimeLimit after three attempts', async () => {
  let calls = 0;
  const { s3 } = setup(undefined, {
    timeoutMs: 20,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      calls += 1;
      signal.addEventListener('abort', () => reject(signal.reason));
    }),
  });
  await assert.rejects(s3.get('k.md'), { message: 'get failed: 0 TimeLimit' });
  assert.equal(calls, 3);
});

test('a response without an error document gives code Unknown', async () => {
  const { s3 } = setup(undefined, { fetchImpl: async () => new Response('SECRET-IN-BODY', { status: 400 }) });
  await assert.rejects(s3.put('k.md', 'x'), { message: 'put failed: 400 Unknown' });
});

test('onRequest runs before a request is served', async () => {
  const { s3, fake } = setup();
  await s3.put('k.md', 'one');
  const stale = (await s3.get('k.md')).etag;
  fake.onRequest(({ method }) => {
    if (method === 'PUT') fake.objects.set('k.md', { body: Buffer.from('other'), etag: md5('other') });
  });
  assert.deepEqual(await s3.put('k.md', 'two', { ifMatch: stale }), { status: 'conflict' });
  assert.equal(fake.objects.get('k.md').body.toString(), 'other');
});

test('the fake answers 403 to a request that is not signed', async () => {
  const fake = createFakeS3();
  const res = await fake.fetch('https://example-bucket.s3.ap-northeast-1.amazonaws.com/k.md', { method: 'GET', headers: {} });
  assert.equal(res.status, 403);
});

test('a key that is empty or has a dot segment is refused before any request', async () => {
  const { s3, fake } = setup();
  await assert.rejects(s3.get(''), { code: 'InvalidKey' });
  await assert.rejects(s3.put('a/../b.md', 'x'), { code: 'InvalidPath' });
  await assert.rejects(s3.del('a//b.md'), { code: 'InvalidPath' });
  assert.equal(fake.requests.length, 0);
});

const BASE = 'https://example-bucket.s3.ap-northeast-1.amazonaws.com';
const redirectTo = () => new Response(null, { status: 307, headers: { location: 'https://evil.example.net/x' } });

test('no call follows a redirect: manual mode, one request, a Redirect error without the location', async () => {
  const calls = [];
  const { s3 } = setup(undefined, {
    fetchImpl: async (url, init) => { calls.push(init); return redirectTo(); },
  });
  const attempts = [
    ['get', () => s3.get('k.md')],
    ['put', () => s3.put('k.md', 'x')],
    ['del', () => s3.del('k.md')],
    ['list', () => s3.list('k/')],
  ];
  for (const [op, run] of attempts) {
    calls.length = 0;
    await assert.rejects(run(), (err) => {
      assert.equal(err.message, `${op} failed: 307 Redirect`);
      assert.ok(!JSON.stringify(err).includes('evil'));
      return true;
    });
    assert.equal(calls.length, 1, op);
    assert.equal(calls[0].redirect, 'manual', op);
  }
});

test('the body of a redirect answer is cancelled before the error is thrown', async () => {
  let cancelled = 0;
  const { s3 } = setup(undefined, {
    fetchImpl: async () => new Response(
      new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(10)); }, cancel() { cancelled += 1; } }),
      { status: 307, headers: { location: 'https://evil.example.net/x' } },
    ),
  });
  await assert.rejects(s3.get('k.md'), /^AwsError: get failed: 307 Redirect$/);
  assert.equal(cancelled, 1);
  // A body that cannot be cancelled does not change the error.
  const locked = setup(undefined, {
    fetchImpl: async () => {
      const res = new Response('x', { status: 302 });
      res.body.getReader();
      return res;
    },
  });
  await assert.rejects(locked.s3.list('k/'), /^AwsError: list failed: 302 Redirect$/);
});

// A fetch that applies the request in the fake and then loses the answer.
function lossy(fake, mode, beforeAnswer = () => {}) {
  let first = true;
  return async (url, init) => {
    const res = await fake.fetch(url, init);
    if (init.method === 'PUT' && first) {
      first = false;
      beforeAnswer();
      if (mode === 'throw') throw new Error('connection reset');
      return new Response('<Error><Code>InternalError</Code></Error>', { status: 500 });
    }
    return res;
  };
}

function lossySetup(mode, beforeAnswer) {
  const fake = createFakeS3();
  const s3 = createS3({
    bucket: 'example-bucket', region: 'ap-northeast-1', credentials, now: () => new Date('2026-01-02T03:04:05Z'),
    sleep: async () => {}, fetchImpl: lossy(fake, mode, beforeAnswer),
  });
  return { fake, s3 };
}

for (const mode of ['throw', '500']) {
  test(`a retried put whose first attempt was applied reports ok (ifNoneMatch, lost answer: ${mode})`, async () => {
    const { s3, fake } = lossySetup(mode);
    assert.deepEqual(await s3.put('k.md', 'mine', { ifNoneMatch: '*' }), { status: 'ok', etag: md5('mine') });
    assert.equal(fake.requests.map((r) => r.method).join(), 'PUT,PUT,GET');
  });

  test(`a retried put whose first attempt was applied reports ok (ifMatch, lost answer: ${mode})`, async () => {
    const { s3, fake } = lossySetup(mode);
    fake.objects.set('k.md', { body: Buffer.from('old'), etag: md5('old') });
    assert.deepEqual(await s3.put('k.md', 'mine', { ifMatch: md5('old') }), { status: 'ok', etag: md5('mine') });
  });

  test(`a retried put is a conflict when another writer's body is in place (lost answer: ${mode})`, async () => {
    let fake;
    const lossyFake = createFakeS3();
    fake = lossyFake;
    const s3 = createS3({
      bucket: 'example-bucket', region: 'ap-northeast-1', credentials, sleep: async () => {},
      fetchImpl: lossy(fake, mode, () => fake.objects.set('k.md', { body: Buffer.from('theirs'), etag: md5('theirs') })),
    });
    assert.deepEqual(await s3.put('k.md', 'mine', { ifNoneMatch: '*' }), { status: 'conflict' });
    assert.equal(fake.objects.get('k.md').body.toString(), 'theirs');
  });
}

test('a first-attempt 412 is a conflict without a read-back', async () => {
  const { s3, fake } = setup();
  await s3.put('k.md', 'one');
  fake.requests.length = 0;
  assert.deepEqual(await s3.put('k.md', 'two', { ifNoneMatch: '*' }), { status: 'conflict' });
  assert.deepEqual(fake.requests.map((r) => r.method), ['PUT']);
});

test('a failing read-back is a conflict', async () => {
  const fake = createFakeS3();
  let gets = 0;
  const lossyPut = lossy(fake, 'throw');
  const s3 = createS3({
    bucket: 'example-bucket', region: 'ap-northeast-1', credentials, sleep: async () => {},
    fetchImpl: async (url, init) => {
      if (init.method === 'GET') { gets += 1; return new Response('<Error><Code>InternalError</Code></Error>', { status: 400 }); }
      return lossyPut(url, init);
    },
  });
  assert.deepEqual(await s3.put('k.md', 'mine', { ifNoneMatch: '*' }), { status: 'conflict' });
  assert.equal(gets, 1);
});

test('an unconditional put is not read back', async () => {
  const { s3, fake } = lossySetup('throw');
  assert.equal((await s3.put('k.md', 'mine')).status, 'ok');
  assert.equal(fake.requests.filter((r) => r.method === 'GET').length, 0);
});

test('a signal that fires ends a call that never answers: TimeLimit, one request', async () => {
  const ctl = new AbortController();
  let calls = 0;
  const { s3 } = setup(undefined, {
    signal: ctl.signal,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      calls += 1;
      signal.addEventListener('abort', () => reject(signal.reason));
    }),
  });
  setTimeout(() => ctl.abort(), 10);
  const started = Date.now();
  await assert.rejects(s3.get('k.md'), { message: 'get failed: 0 TimeLimit' });
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 2000);
});

test('a signal that fires during the retry wait ends the call without a second request', async () => {
  const ctl = new AbortController();
  let calls = 0;
  const { s3 } = setup(undefined, {
    signal: ctl.signal,
    fetchImpl: async () => { calls += 1; return new Response('<Error><Code>SlowDown</Code></Error>', { status: 503 }); },
    sleep: () => new Promise((resolve) => { setTimeout(resolve, 10_000).unref(); }),
  });
  setTimeout(() => ctl.abort(), 20);
  const started = Date.now();
  await assert.rejects(s3.get('k.md'), { message: 'get failed: 0 TimeLimit' });
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 2000);
});

test('an already aborted signal sends nothing', async () => {
  const { s3, fake } = setup(undefined, { signal: AbortSignal.abort() });
  for (const run of [() => s3.get('k.md'), () => s3.put('k.md', 'x'), () => s3.del('k.md'), () => s3.list('k/')]) {
    await assert.rejects(run(), (err) => err.status === 0 && err.code === 'TimeLimit');
  }
  assert.equal(fake.requests.length, 0);
});

test('a put whose signal fired is not turned into a conflict by the read-back', async () => {
  const ctl = new AbortController();
  const fake = createFakeS3();
  const s3 = createS3({
    bucket: 'example-bucket', region: 'ap-northeast-1', credentials, sleep: async () => {}, signal: ctl.signal,
    fetchImpl: lossy(fake, 'throw', () => {}),
  });
  fake.onRequest(({ method }) => { if (method === 'GET') ctl.abort(); });
  await assert.rejects(s3.put('k.md', 'mine', { ifNoneMatch: '*' }), { code: 'TimeLimit' });
});

test('list: a truncated page without a continuation token is BadListing', async () => {
  const { s3 } = setup(undefined, {
    fetchImpl: async () => new Response('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>', { status: 200 }),
  });
  await assert.rejects(s3.list('k/'), { message: 'list failed: 200 BadListing' });
});

test('list: truncated empty pages forever end with TooManyKeys after a bounded number of requests', async () => {
  let calls = 0;
  const { s3 } = setup(undefined, {
    fetchImpl: async () => {
      calls += 1;
      return new Response('<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t</NextContinuationToken></ListBucketResult>', { status: 200 });
    },
  });
  await assert.rejects(s3.list('k/', { maxKeys: 2500 }), { message: 'list failed: 0 TooManyKeys' });
  assert.equal(calls, 4);
});

test('list requires a string prefix', async () => {
  const { s3, fake } = setup();
  for (const prefix of [undefined, null, 5]) await assert.rejects(s3.list(prefix), { code: 'InvalidPrefix' });
  assert.equal(fake.requests.length, 0);
});

test('list decodes named and numeric XML entities in ETags and keys', async () => {
  const xml = '<ListBucketResult><IsTruncated>false</IsTruncated>'
    + '<Contents><Key>a%26b</Key><ETag>&#34;abc&#34;</ETag><Size>1</Size></Contents>'
    + '<Contents><Key>c</Key><ETag>&#x22;def&#x22;</ETag><Size>2</Size></Contents>'
    + '<Contents><Key>d</Key><ETag>&quot;ghi&amp;#34;</ETag><Size>3</Size></Contents></ListBucketResult>';
  const { s3 } = setup(undefined, { fetchImpl: async () => new Response(xml, { status: 200 }) });
  assert.deepEqual(await s3.list(''), [
    { key: 'a&b', etag: '"abc"', size: 1 },
    { key: 'c', etag: '"def"', size: 2 },
    { key: 'd', etag: '"ghi&#34;', size: 3 },
  ]);
});

test('a 200 answer to get or put without an ETag is a NoETag error', async () => {
  const { s3 } = setup(undefined, { fetchImpl: async () => new Response('x', { status: 200 }) });
  await assert.rejects(s3.get('k.md'), { message: 'get failed: 200 NoETag' });
  await assert.rejects(s3.put('k.md', 'x'), { message: 'put failed: 200 NoETag' });
});

test('get refuses a body larger than maxBytes, by header and by actual size', async () => {
  let pulled = 0;
  const big = new Response(new ReadableStream({
    pull(c) { pulled += 1; c.enqueue(new Uint8Array(1000)); if (pulled > 1000) c.close(); },
  }), { status: 200, headers: { etag: '"x"' } });
  const { s3 } = setup(undefined, { fetchImpl: async () => big });
  await assert.rejects(s3.get('k.md', { maxBytes: 5000 }), { message: 'get failed: 200 TooLarge' });
  assert.ok(pulled < 20, `read ${pulled} chunks`);

  const declared = setup(undefined, {
    fetchImpl: async () => new Response('x', { status: 200, headers: { etag: '"x"', 'content-length': '999999' } }),
  });
  await assert.rejects(declared.s3.get('k.md', { maxBytes: 5000 }), { message: 'get failed: 200 TooLarge' });

  const fine = setup(undefined, { fetchImpl: async () => new Response('abc', { status: 200, headers: { etag: '"x"' } }) });
  assert.equal((await fine.s3.get('k.md', { maxBytes: 3 })).body.toString(), 'abc');
});

test('the exact URLs of a get, a put with a nested key and a listing', async () => {
  const { s3, fake } = setup();
  await s3.put('mem/projects/demo.app/note-1.md', 'x');
  await s3.get('mem/global/a.md');
  await s3.list('agents/');
  assert.deepEqual(fake.requests.map((r) => r.url), [
    `${BASE}/mem/projects/demo.app/note-1.md`,
    `${BASE}/mem/global/a.md`,
    `${BASE}/?encoding-type=url&list-type=2&prefix=agents%2F`,
  ]);
});

test('the fake answers 501 to an if-none-match value other than *', async () => {
  const fake = createFakeS3();
  const res = await fake.fetch(`${BASE}/k.md`, {
    method: 'PUT', body: 'x', headers: { authorization: 'AWS4-HMAC-SHA256 x', 'if-none-match': '"abc"' },
  });
  assert.equal(res.status, 501);
  assert.match(await res.text(), /<Code>NotImplemented<\/Code>/);
  assert.equal(fake.objects.size, 0);
});

test('the fake lists keys in UTF-8 byte order, also across pages', async () => {
  const { s3, fake } = setup({ pageSize: 1 });
  for (const k of ['k/\u{1F600}', 'k/￿', 'k/a']) fake.objects.set(k, { body: Buffer.from('x'), etag: md5('x') });
  assert.deepEqual((await s3.list('k/')).map((o) => o.key), ['k/a', 'k/￿', 'k/\u{1F600}']);
});

test('an invalid bucket or region makes the factory throw', () => {
  const ok = { bucket: 'example-bucket', region: 'ap-northeast-1', credentials };
  assert.doesNotThrow(() => createS3(ok));
  for (const bucket of ['Example', 'a', '-bad', 'bad-', 'a.b.c', 'x/../y', '']) {
    assert.throws(() => createS3({ ...ok, bucket }), AwsError, bucket);
  }
  for (const region of ['', 'apnortheast1', 'ap-northeast-1.evil.example', 'AP-NORTHEAST-1', 'ap-northeast-']) {
    assert.throws(() => createS3({ ...ok, region }), AwsError, region);
  }
});
