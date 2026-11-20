import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AwsError, assumeRole, environmentCredentials, imdsCredentials, signRequest, ssmGetParameter } from '../lib/aws.mjs';

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

// ---- assumeRole ----

const ROLE = 'arn:aws:iam::123456789012:role/example-bridge';
const STS_OPTS = {
  roleArn: ROLE, sessionName: 'agent-memory-bridge', region: 'ap-northeast-1', credentials: credsToken, now: () => T2,
};
const STS_BODY = 'Action=AssumeRole&Version=2011-06-15&RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2Fexample-bridge'
  + '&RoleSessionName=agent-memory-bridge&DurationSeconds=900';
const STS_AUTH = 'AWS4-HMAC-SHA256 Credential=EXAMPLEKEYID/20260102/ap-northeast-1/sts/aws4_request, '
  + 'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, '
  + 'Signature=e35de9984206358a00de67476fd83f30e4de00fa42b1ea2d78acd378087dac0f';
const stsXml = (credentials = '<AccessKeyId>ROLEKEYID</AccessKeyId><SecretAccessKey>role-signing-value</SecretAccessKey><SessionToken>role-session-value</SessionToken><Expiration>2026-01-02T03:19:05Z</Expiration>') => `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials>${credentials}</Credentials></AssumeRoleResult></AssumeRoleResponse>`;
const stsErrorXml = (code, message) => `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>`;

test('assumeRole sends the signed request of the signature vector and returns the credentials', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(stsXml(), { status: 200 });
  };
  const out = await assumeRole({ ...STS_OPTS, fetchImpl });
  assert.deepEqual(out, {
    accessKeyId: 'ROLEKEYID', secretAccessKey: 'role-signing-value', sessionToken: 'role-session-value', expiration: '2026-01-02T03:19:05Z',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://sts.ap-northeast-1.amazonaws.com/');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, STS_BODY);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.authorization, STS_AUTH);
  assert.equal(calls[0].init.headers['content-type'], 'application/x-www-form-urlencoded; charset=utf-8');
  assert.equal(calls[0].init.headers.host, undefined);
});

test('assumeRole: a longer duration is sent', async () => {
  let body;
  const fetchImpl = async (url, init) => { body = init.body; return new Response(stsXml(), { status: 200 }); };
  await assumeRole({ ...STS_OPTS, durationSeconds: 3600, fetchImpl });
  assert.ok(body.endsWith('&DurationSeconds=3600'));
});

test('assumeRole rejects each invalid input before any request', async () => {
  const fetchImpl = async () => assert.fail('no request');
  const bad = [
    { roleArn: 'arn:aws:iam::12345:role/x' }, { roleArn: 'arn:aws:iam::123456789012:user/x' }, { roleArn: 'arn:aws:iam::123456789012:role/' },
    { roleArn: `${ROLE}\n` }, { roleArn: `${ROLE} x` }, { roleArn: 5 }, { roleArn: undefined },
    { sessionName: 'a' }, { sessionName: 'a'.repeat(65) }, { sessionName: 'a b' }, { sessionName: 'a&b=c' }, { sessionName: undefined },
    { durationSeconds: 899 }, { durationSeconds: 3601 }, { durationSeconds: 900.5 }, { durationSeconds: '900' }, { durationSeconds: NaN },
    { region: 'nowhere' }, { region: 'a.b' }, { credentials: undefined }, { credentials: { accessKeyId: 'X' } },
  ];
  for (const over of bad) {
    await assert.rejects(assumeRole({ ...STS_OPTS, ...over, fetchImpl }), { message: 'sts failed: 0 InvalidRequest' }, JSON.stringify(over));
  }
});

test('assumeRole accepts paths and the other partitions in a role ARN', async () => {
  const fetchImpl = async () => new Response(stsXml(), { status: 200 });
  for (const roleArn of ['arn:aws:iam::123456789012:role/a/b/example-role', 'arn:aws-cn:iam::123456789012:role/x', 'arn:aws-us-gov:iam::123456789012:role/x+=,.@-_y']) {
    await assumeRole({ ...STS_OPTS, roleArn, fetchImpl });
  }
});

test('assumeRole reports the status and the code of an error answer and never its text', async () => {
  const fetchImpl = async () => new Response(stsErrorXml('AccessDenied', 'User: SECRET-IN-BODY is not authorized'), { status: 403 });
  await assert.rejects(assumeRole({ ...STS_OPTS, fetchImpl }), (err) => {
    assert.equal(err.message, 'sts failed: 403 AccessDenied');
    assert.ok(err instanceof AwsError);
    assert.ok(!JSON.stringify(err).includes('SECRET'));
    assert.ok(!String(err.stack).includes('SECRET'));
    return true;
  });
});

test('assumeRole: an error answer without a usable code is Unknown, a hostile code too', async () => {
  for (const text of ['not xml', '', stsErrorXml('a b SECRET-IN-BODY', 'x'), stsErrorXml('x'.repeat(100), 'x'), '<Code></Code>']) {
    const fetchImpl = async () => new Response(text, { status: 500 });
    await assert.rejects(assumeRole({ ...STS_OPTS, fetchImpl }), { message: 'sts failed: 500 Unknown' });
  }
});

test('assumeRole never follows a redirect', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init.redirect);
    return new Response(null, { status: 307, headers: { location: 'https://evil.example.net/x' } });
  };
  await assert.rejects(assumeRole({ ...STS_OPTS, fetchImpl }), (err) => {
    assert.equal(err.message, 'sts failed: 307 Redirect');
    assert.ok(!JSON.stringify(err).includes('evil'));
    return true;
  });
  assert.deepEqual(calls, ['manual']);
});

test('assumeRole turns a network error into status 0 without the fetch message', async () => {
  const fetchImpl = async () => { throw new Error('connect ECONNREFUSED https://sts.example.com/'); };
  await assert.rejects(assumeRole({ ...STS_OPTS, fetchImpl }), { message: 'sts failed: 0 Network' });
});

const hangs = (url, { signal }) => new Promise((resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason));
});

test('assumeRole ends within timeoutMs as a TimeLimit', async () => {
  await assert.rejects(assumeRole({ ...STS_OPTS, fetchImpl: hangs, timeoutMs: 30 }), { message: 'sts failed: 0 TimeLimit' });
});

test('assumeRole ends when the given signal is aborted', async () => {
  const controller = new AbortController();
  const pending = assumeRole({ ...STS_OPTS, fetchImpl: hangs, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { message: 'sts failed: 0 TimeLimit' });
  const done = new AbortController();
  done.abort();
  await assert.rejects(assumeRole({ ...STS_OPTS, fetchImpl: hangs, signal: done.signal }), { message: 'sts failed: 0 TimeLimit' });
});

test('assumeRole: a 200 answer without the three values is BadAnswer', async () => {
  const parts = {
    id: '<AccessKeyId>ROLEKEYID</AccessKeyId>', secret: '<SecretAccessKey>role-signing-value</SecretAccessKey>',
    token: '<SessionToken>role-session-value</SessionToken>', expiration: '<Expiration>2026-01-02T03:19:05Z</Expiration>',
  };
  const without = (name) => Object.entries(parts).filter(([k]) => k !== name).map(([, v]) => v).join('');
  const texts = ['', 'not xml', '<AssumeRoleResponse/>', stsXml(''), ...Object.keys(parts).map((k) => stsXml(without(k))),
    stsXml('<AccessKeyId></AccessKeyId><SecretAccessKey>x</SecretAccessKey><SessionToken>y</SessionToken><Expiration>2026-01-02T03:19:05Z</Expiration>'),
    stsXml(Object.values(parts).join('').replace('ROLEKEYID', 'bad key id')),
    stsXml(Object.values(parts).join('').replace('2026-01-02T03:19:05Z', 'tomorrow'))];
  for (const text of texts) {
    const fetchImpl = async () => new Response(text, { status: 200 });
    await assert.rejects(assumeRole({ ...STS_OPTS, fetchImpl }), { message: 'sts failed: 200 BadAnswer' }, text.slice(0, 80));
  }
});

test('assumeRole takes the values from the first Credentials element only', async () => {
  const first = '<AccessKeyId>FIRSTKEYID</AccessKeyId><SecretAccessKey>first-signing-value</SecretAccessKey><SessionToken>first-session-value</SessionToken><Expiration>2026-01-02T03:19:05Z</Expiration>';
  const second = '<AccessKeyId>SECONDKEYID</AccessKeyId><SecretAccessKey>second-signing-value</SecretAccessKey><SessionToken>second-session-value</SessionToken><Expiration>2026-01-02T03:19:05Z</Expiration>';
  const two = (a, b) => `<R><Credentials>${a}</Credentials><Credentials>${b}</Credentials></R>`;
  let out = await assumeRole({ ...STS_OPTS, fetchImpl: async () => new Response(two(first, second), { status: 200 }) });
  assert.equal(out.accessKeyId, 'FIRSTKEYID');
  // Values missing from the first element are not completed from the second.
  await assert.rejects(
    assumeRole({ ...STS_OPTS, fetchImpl: async () => new Response(two('<AccessKeyId>FIRSTKEYID</AccessKeyId>', second), { status: 200 }) }),
    { message: 'sts failed: 200 BadAnswer' },
  );
});

test('assumeRole: a session token of 5000 characters is accepted, one of 16385 is BadAnswer', async () => {
  const answer = (token) => stsXml(`<AccessKeyId>ROLEKEYID</AccessKeyId><SecretAccessKey>role-signing-value</SecretAccessKey><SessionToken>${token}</SessionToken><Expiration>2026-01-02T03:19:05Z</Expiration>`);
  const longToken = 'a'.repeat(5000);
  const ok = await assumeRole({ ...STS_OPTS, fetchImpl: async () => new Response(answer(longToken), { status: 200 }) });
  assert.equal(ok.sessionToken, longToken);
  const edge = await assumeRole({ ...STS_OPTS, fetchImpl: async () => new Response(answer('a'.repeat(16384)), { status: 200 }) });
  assert.equal(edge.sessionToken.length, 16384);
  await assert.rejects(
    assumeRole({ ...STS_OPTS, fetchImpl: async () => new Response(answer('a'.repeat(16385)), { status: 200 }) }),
    { message: 'sts failed: 200 BadAnswer' },
  );
});

// ---- environmentCredentials ----

const ENV_OK = {
  AWS_ACCESS_KEY_ID: 'ASIAEXAMPLEKEYID', AWS_SECRET_ACCESS_KEY: 'example/signing+value=', AWS_SESSION_TOKEN: 'example/session+value=_.-',
};

test('environmentCredentials returns the three values, synchronously', () => {
  assert.deepEqual(environmentCredentials(ENV_OK), {
    accessKeyId: 'ASIAEXAMPLEKEYID', secretAccessKey: 'example/signing+value=', sessionToken: 'example/session+value=_.-',
  });
});

test('environmentCredentials: a missing or empty variable is NoEnvironment, with no session token too', () => {
  for (const name of Object.keys(ENV_OK)) {
    for (const value of [undefined, '']) {
      const env = { ...ENV_OK, [name]: value };
      assert.throws(() => environmentCredentials(env), (err) => {
        assert.ok(err instanceof AwsError);
        assert.deepEqual([err.operation, err.status, err.code], ['credentials', 0, 'NoEnvironment']);
        assert.equal(err.message, 'credentials failed: 0 NoEnvironment');
        return true;
      }, `${name}=${JSON.stringify(value)}`);
    }
  }
  assert.throws(() => environmentCredentials({}), /credentials failed: 0 NoEnvironment/);
  // Long-lived credentials (no session token) are never accepted.
  const { AWS_SESSION_TOKEN: _drop, ...longLived } = ENV_OK;
  assert.throws(() => environmentCredentials(longLived), /credentials failed: 0 NoEnvironment/);
});

test('environmentCredentials: a malformed value is BadEnvironment and the error holds nothing of any value', () => {
  const bad = 'bad value with spaces and \u00e9 SECRET-IN-VALUE';
  const cases = [
    { AWS_ACCESS_KEY_ID: bad }, { AWS_ACCESS_KEY_ID: 'AKIA-EXAMPLE' }, { AWS_ACCESS_KEY_ID: 'A'.repeat(129) },
    { AWS_SECRET_ACCESS_KEY: bad }, { AWS_SECRET_ACCESS_KEY: 'a\nb' }, { AWS_SECRET_ACCESS_KEY: 'a'.repeat(16385) },
    { AWS_SESSION_TOKEN: bad }, { AWS_SESSION_TOKEN: 'a\r\nb' }, { AWS_SESSION_TOKEN: 'a'.repeat(16385) },
  ];
  for (const over of cases) {
    const env = { ...ENV_OK, ...over };
    assert.throws(() => environmentCredentials(env), (err) => {
      assert.equal(err.message, 'credentials failed: 0 BadEnvironment');
      assert.equal(err.code, 'BadEnvironment');
      for (const value of Object.values(env)) assert.ok(!JSON.stringify(err).includes(value) && !err.message.includes(value) && !String(err.stack).includes(value));
      return true;
    }, JSON.stringify(Object.keys(over)));
  }
});

test('environmentCredentials reads process.env by default and no request is made', () => {
  const saved = Object.fromEntries(Object.keys(ENV_OK).map((k) => [k, process.env[k]]));
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('no request');
  try {
    Object.assign(process.env, ENV_OK);
    assert.equal(environmentCredentials().accessKeyId, 'ASIAEXAMPLEKEYID');
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
