import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AwsError, imdsCredentials, signRequest, ssmGetParameter } from '../lib/aws.mjs';

const creds = { accessKeyId: 'EXAMPLEKEYID', secretAccessKey: 'example-signing-value' };
const credsToken = { ...creds, sessionToken: 'example-session-value' };

const T1 = new Date('2013-05-24T00:00:00Z');
const T2 = new Date('2026-01-02T03:04:05Z');
const S3_HOST = 'example-bucket.s3.ap-northeast-1.amazonaws.com';
const S3_AUTH = 'AWS4-HMAC-SHA256 Credential=EXAMPLEKEYID/20260102/ap-northeast-1/s3/aws4_request, ';

const vectors = [
  ['1: GET with range header', {
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' },
    service: 's3', region: 'us-east-1', credentials: creds, now: T1,
  }, 'AWS4-HMAC-SHA256 Credential=EXAMPLEKEYID/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=05ef132330e575597c22fa0a7334a53c99cf79cb658098b7fcadfb280f294f34'],
  ['2: GET with query', {
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/', query: { 'max-keys': '2', prefix: 'J' },
    service: 's3', region: 'us-east-1', credentials: creds, now: T1,
  }, 'AWS4-HMAC-SHA256 Credential=EXAMPLEKEYID/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=95646d0fa96ef1a96e19031f9569582899239c60ec1dbf0a68515f47262039c4'],
  ['3: PUT with token and body', {
    method: 'PUT', host: S3_HOST, path: '/mem/projects/demo.app/note-1.md',
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'if-none-match': '*' },
    body: '---\nname: note-1\n---\n\nhello\n', service: 's3', region: 'ap-northeast-1', credentials: credsToken, now: T2,
  }, `${S3_AUTH}SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=638553e4566de0fdd59cd212a56e1f867892588f10296cf1d6079e5ca3d4c937`],
  ['4: listing query with reserved characters', {
    method: 'GET', host: S3_HOST, path: '/',
    query: { 'list-type': '2', prefix: 'agents/', 'encoding-type': 'url', 'continuation-token': 'a+b/c=' },
    service: 's3', region: 'ap-northeast-1', credentials: credsToken, now: T2,
  }, `${S3_AUTH}SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=831a3ebb780e220e1c581cbff712ee30842d65a13709c452965414ad3f998151`],
  ['5: DELETE', {
    method: 'DELETE', host: S3_HOST, path: '/mem/global/old_note.md',
    service: 's3', region: 'ap-northeast-1', credentials: credsToken, now: T2,
  }, `${S3_AUTH}SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=c10a9cbfb31da274865fb9818142e9934338e3f78cef6fe33004ce63d9859b40`],
  ['6: SSM POST', {
    method: 'POST', host: 'ssm.ap-northeast-1.amazonaws.com', path: '/',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AmazonSSM.GetParameter' },
    body: '{"Name":"/example/prod/secret","WithDecryption":true}', service: 'ssm', region: 'ap-northeast-1',
    credentials: credsToken, now: T2,
  }, 'AWS4-HMAC-SHA256 Credential=EXAMPLEKEYID/20260102/ap-northeast-1/ssm/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token;x-amz-target, Signature=6e3552ab0dba25928c6be78d3f3f8f822e53c3c2089cbca049765d4dd36b55ec'],
  // 7 and 8: computed with the official signer (@smithy/signature-v4) outside the repository.
  ['7: listing query with reserved characters and an empty value', {
    method: 'GET', host: S3_HOST, path: '/',
    query: { 'list-type': '2', prefix: "a b+c%d~e*f!g'h(i)j/é", 'start-after': '' },
    service: 's3', region: 'ap-northeast-1', credentials: credsToken, now: T2,
  }, `${S3_AUTH}SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=e3ab837006492e8b0a4b57dadc5759cdffdbffb4263079a81cec93c834369d0e`],
  ['8: PUT with mixed-case headers and inner whitespace', {
    method: 'PUT', host: S3_HOST, path: '/mem/global/a~b.md',
    headers: { 'Content-Type': '  text/markdown;   charset=utf-8  ', 'X-Amz-Meta-Note': 'two  spaces' },
    body: 'x', service: 's3', region: 'ap-northeast-1', credentials: credsToken, now: T2,
  }, `${S3_AUTH}SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-note;x-amz-security-token, Signature=855ec5071a4cb4c7219486522fab94e43932d127c1e6fbfb2c6feeb5d4e75ab9`],
];

for (const [name, request, expected] of vectors) {
  test(`signRequest reproduces vector ${name}`, () => {
    assert.equal(signRequest(request).authorization, expected);
  });
}

test('signRequest returns every signed header with a lower-case name', () => {
  const h = signRequest(vectors[2][1]);
  assert.deepEqual(Object.keys(h).sort(), [
    'authorization', 'content-type', 'host', 'if-none-match',
    'x-amz-content-sha256', 'x-amz-date', 'x-amz-security-token',
  ]);
  assert.equal(h['x-amz-date'], '20260102T030405Z');
});

test('signRequest rejects paths that could reach another object', () => {
  for (const path of ['/a/../b', '/a//b', '/a/./b', '/a b', '/a%2Fb', '/a/..', 'a', '/a?x=1']) {
    assert.throws(
      () => signRequest({ ...vectors[4][1], path }),
      (err) => err instanceof AwsError && err.code === 'InvalidPath' && err.message === 'sign failed: 0 InvalidPath',
      path,
    );
  }
});

test('signRequest rejects a header value with a line break', () => {
  for (const value of ['a\nb', 'a\rb']) {
    assert.throws(
      () => signRequest({ ...vectors[4][1], headers: { 'x-test': value } }),
      (err) => err.code === 'InvalidHeader',
    );
  }
});

test('signRequest rejects a header name that is not a plain token', () => {
  for (const name of ['x y', 'a:b', 'a\nb', 'é', '', 'x_y']) {
    assert.throws(
      () => signRequest({ ...vectors[4][1], headers: { [name]: 'v' } }),
      (err) => err instanceof AwsError && err.message === 'sign failed: 0 InvalidHeader',
      JSON.stringify(name),
    );
  }
});

// A fetch that answers by URL and records what it was asked.
function imdsFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, redirect: init.redirect });
    const route = routes(url, init);
    return new Response(route.body, { status: route.status ?? 200 });
  };
  return { fetchImpl, calls };
}

const roleDoc = JSON.stringify({
  AccessKeyId: 'EXAMPLEKEYID', SecretAccessKey: 'example-signing-value', Token: 'example-session-value',
  Expiration: '2026-01-02T09:00:00Z',
});

test('imdsCredentials sends the token on the second and third request and maps the fields', async () => {
  const { fetchImpl, calls } = imdsFetch((url) => {
    if (url.endsWith('/api/token')) return { body: 'token-value\n' };
    if (url.endsWith('/security-credentials/')) return { body: 'example-role\n' };
    return { body: roleDoc };
  });
  const got = await imdsCredentials({ fetchImpl });
  assert.deepEqual(got, {
    accessKeyId: 'EXAMPLEKEYID', secretAccessKey: 'example-signing-value',
    sessionToken: 'example-session-value', expiration: '2026-01-02T09:00:00Z',
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.redirect), ['manual', 'manual', 'manual']);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].headers['x-aws-ec2-metadata-token-ttl-seconds'], '21600');
  assert.equal(calls[1].headers['x-aws-ec2-metadata-token'], 'token-value');
  assert.equal(calls[2].headers['x-aws-ec2-metadata-token'], 'token-value');
  assert.equal(calls[2].url, 'http://169.254.169.254/latest/meta-data/iam/security-credentials/example-role');
});

test('imdsCredentials: a 404 on the role request is Unavailable', async () => {
  const { fetchImpl } = imdsFetch((url) => (url.endsWith('/api/token') ? { body: 't' } : { status: 404, body: 'x' }));
  await assert.rejects(imdsCredentials({ fetchImpl }), (err) => {
    assert.ok(err instanceof AwsError);
    assert.equal(err.message, 'credentials failed: 404 Unavailable');
    return true;
  });
});

test('imdsCredentials: a role name that is not a plain name is refused', async () => {
  const { fetchImpl } = imdsFetch((url) => (url.endsWith('/api/token') ? { body: 't' } : { body: '../x' }));
  await assert.rejects(imdsCredentials({ fetchImpl }), { message: 'credentials failed: 0 Unavailable' });
});

test('imdsCredentials: a document without the fields is Unavailable', async () => {
  const { fetchImpl } = imdsFetch((url) => {
    if (url.endsWith('/api/token')) return { body: 't' };
    if (url.endsWith('/security-credentials/')) return { body: 'r' };
    return { body: '{"AccessKeyId":"EXAMPLEKEYID"}' };
  });
  await assert.rejects(imdsCredentials({ fetchImpl }), { message: 'credentials failed: 0 Unavailable' });
});

for (const hanging of [0, 1, 2]) {
  test(`imdsCredentials ends within timeoutMs when request ${hanging + 1} never answers`, async () => {
    let n = 0;
    const fetchImpl = (url, { signal }) => {
      const mine = n++;
      if (mine === hanging) {
        return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); });
      }
      if (mine === 0) return Promise.resolve(new Response('t'));
      if (mine === 1) return Promise.resolve(new Response('r'));
      return Promise.resolve(new Response(roleDoc));
    };
    const started = Date.now();
    await assert.rejects(imdsCredentials({ fetchImpl, timeoutMs: 30 }), { message: 'credentials failed: 0 Unavailable' });
    assert.equal(n, hanging + 1);
    assert.ok(Date.now() - started < 2000);
  });
}

test('imdsCredentials never follows a redirect', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    return new Response(null, { status: 307, headers: { location: 'https://evil.example.net/x' } });
  };
  await assert.rejects(imdsCredentials({ fetchImpl }), (err) => {
    assert.equal(err.message, 'credentials failed: 307 Unavailable');
    assert.ok(!JSON.stringify(err).includes('evil'));
    return true;
  });
  assert.deepEqual(calls.map((c) => c.redirect), ['manual']);
});

const SSM_OPTS = { name: '/example/prod/secret', region: 'ap-northeast-1', credentials: credsToken, now: () => T2 };

test('ssmGetParameter returns the value and sends a signed, decrypting request', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ Parameter: { Value: 'example-value' } }), { status: 200 });
  };
  assert.equal(await ssmGetParameter({ ...SSM_OPTS, fetchImpl }), 'example-value');
  assert.equal(seen.url, 'https://ssm.ap-northeast-1.amazonaws.com/');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.redirect, 'manual');
  assert.deepEqual(JSON.parse(seen.init.body), { Name: '/example/prod/secret', WithDecryption: true });
  assert.equal(seen.init.headers['x-amz-target'], 'AmazonSSM.GetParameter');
  assert.match(seen.init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=EXAMPLEKEYID\/20260102\/ap-northeast-1\/ssm\/aws4_request, /);
});

test('ssmGetParameter reports the error code and never the response text', async () => {
  const body = JSON.stringify({ __type: 'com.amazonaws.ssm#ParameterNotFound', message: 'SECRET-IN-BODY' });
  const fetchImpl = async () => new Response(body, { status: 400 });
  await assert.rejects(ssmGetParameter({ ...SSM_OPTS, fetchImpl }), (err) => {
    assert.equal(err.message, 'ssm failed: 400 ParameterNotFound');
    assert.ok(!JSON.stringify(err).includes('SECRET-IN-BODY'));
    return true;
  });
});

test('ssmGetParameter: an error without a usable type is Unknown, a hostile type too', async () => {
  for (const text of ['not json', '{"__type":"a#b c SECRET-IN-BODY"}']) {
    const fetchImpl = async () => new Response(text, { status: 500 });
    await assert.rejects(ssmGetParameter({ ...SSM_OPTS, fetchImpl }), { message: 'ssm failed: 500 Unknown' });
  }
});

test('ssmGetParameter turns a network error into status 0 without the fetch message', async () => {
  const fetchImpl = async () => { throw new Error('connect ECONNREFUSED https://ssm.example.com/'); };
  await assert.rejects(ssmGetParameter({ ...SSM_OPTS, fetchImpl }), { message: 'ssm failed: 0 Network' });
});

test('ssmGetParameter never follows a redirect', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    return new Response(null, { status: 307, headers: { location: 'https://evil.example.net/x' } });
  };
  await assert.rejects(ssmGetParameter({ ...SSM_OPTS, fetchImpl }), (err) => {
    assert.equal(err.message, 'ssm failed: 307 Redirect');
    assert.ok(!JSON.stringify(err).includes('evil'));
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, 'manual');
});

test('ssmGetParameter ends within timeoutMs as a TimeLimit', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  await assert.rejects(ssmGetParameter({ ...SSM_OPTS, fetchImpl, timeoutMs: 30 }), { message: 'ssm failed: 0 TimeLimit' });
});
