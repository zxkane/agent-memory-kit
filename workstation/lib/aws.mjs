import { createHash, createHmac } from 'node:crypto';

// Errors carry the operation, the HTTP status and the AWS error code, nothing else: a response
// body, a header or a URL never reaches a message.
export class AwsError extends Error {
  constructor(operation, status, code) {
    super(`${operation} failed: ${status} ${code}`);
    this.name = 'AwsError';
    this.operation = operation;
    this.status = status;
    this.code = code;
  }
}

const PATH_RE = /^\/[A-Za-z0-9._~/_-]*$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// An error code taken from a response is only reported when it looks like a code, so that a
// body that is not an AWS error document cannot put its text into a message.
export function safeCode(text) {
  return CODE_RE.test(text ?? '') ? text : 'Unknown';
}

// A failed fetch becomes a status-0 error. err.message is left out on purpose: it can hold a URL.
export function networkError(operation, err) {
  const limit = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return new AwsError(operation, 0, limit ? 'TimeLimit' : 'Network');
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// RFC 3986: only unreserved characters stay; encodeURIComponent also leaves !'()*.
const encodeRfc3986 = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function canonicalQuery(query) {
  return Object.entries(query)
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(String(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function checkPath(path) {
  const ok = typeof path === 'string' && PATH_RE.test(path) && !path.includes('//')
    && !path.split('/').some((seg) => seg === '.' || seg === '..');
  if (!ok) throw new AwsError('sign', 0, 'InvalidPath');
}

// Signature Version 4. Returns the headers to send; every one of them is signed. The path is
// used as given (S3 does not encode twice), so callers pass only the characters PATH_RE allows.
export function signRequest({ method, host, path, query = {}, headers = {}, body = '', service, region, credentials, now }) {
  checkPath(path);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const all = {};
  const put = (name, value) => {
    const key = name.toLowerCase();
    const v = String(value).trim();
    if (!/^[a-z0-9-]+$/.test(key) || /[\r\n]/.test(String(value)) || key in all) throw new AwsError('sign', 0, 'InvalidHeader');
    all[key] = v;
  };
  for (const [name, value] of Object.entries(headers)) put(name, value);
  put('host', host);
  put('x-amz-date', amzDate);
  put('x-amz-content-sha256', payloadHash);
  if (credentials.sessionToken) put('x-amz-security-token', credentials.sessionToken);

  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n].replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [method, path, canonicalQuery(query), canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n');
  let key = hmac(`AWS4${credentials.secretAccessKey}`, day);
  for (const part of [region, service, 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(toSign).digest('hex');

  all.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return all;
}

const IMDS = 'http://169.254.169.254';
const ROLE_RE = /^[A-Za-z0-9_+=,.@-]{1,64}$/;

// Credentials of the instance role (IMDSv2). They are returned to the caller, never stored here.
export async function imdsCredentials({ fetchImpl = fetch, timeoutMs = 2000 } = {}) {
  const unavailable = (status = 0) => new AwsError('credentials', status, 'Unavailable');
  const call = async (method, path, headers) => {
    let res;
    try {
      res = await fetchImpl(`${IMDS}${path}`, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw unavailable(res.status);
      return await res.text();
    } catch (err) {
      throw err instanceof AwsError ? err : unavailable();
    }
  };
  const token = (await call('PUT', '/latest/api/token', { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' })).trim();
  const auth = { 'x-aws-ec2-metadata-token': token };
  const role = (await call('GET', '/latest/meta-data/iam/security-credentials/', auth)).split('\n')[0].trim();
  if (!ROLE_RE.test(role)) throw unavailable();
  const text = await call('GET', `/latest/meta-data/iam/security-credentials/${role}`, auth);
  let doc;
  try { doc = JSON.parse(text); } catch { throw unavailable(); }
  const { AccessKeyId, SecretAccessKey, Token, Expiration } = doc ?? {};
  if (![AccessKeyId, SecretAccessKey, Token, Expiration].every((v) => typeof v === 'string' && v)) throw unavailable();
  return { accessKeyId: AccessKeyId, secretAccessKey: SecretAccessKey, sessionToken: Token, expiration: Expiration };
}

export async function ssmGetParameter({ name, region, credentials, fetchImpl = fetch, now = () => new Date(), timeoutMs = 10000 }) {
  if (!REGION_RE.test(region)) throw new AwsError('ssm', 0, 'InvalidRegion');
  const host = `ssm.${region}.amazonaws.com`;
  const body = JSON.stringify({ Name: name, WithDecryption: true });
  const headers = signRequest({
    method: 'POST', host, path: '/', service: 'ssm', region, credentials, now: now(), body,
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AmazonSSM.GetParameter' },
  });
  delete headers.host; // set from the URL by fetch
  let status;
  let text;
  try {
    const res = await fetchImpl(`https://${host}/`, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    status = res.status;
    text = await res.text();
  } catch (err) {
    throw networkError('ssm', err);
  }
  let doc;
  try { doc = JSON.parse(text); } catch { doc = null; }
  if (status >= 300 && status < 400) throw new AwsError('ssm', status, 'Redirect');
  if (status < 200 || status >= 300) {
    const type = typeof doc?.__type === 'string' ? doc.__type.split('#').pop() : '';
    throw new AwsError('ssm', status, safeCode(type));
  }
  const value = doc?.Parameter?.Value;
  if (typeof value !== 'string') throw new AwsError('ssm', status, 'BadResponse');
  return value;
}
