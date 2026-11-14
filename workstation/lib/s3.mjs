import { createHash } from 'node:crypto';
import { AwsError, networkError, safeCode, signRequest, canonicalQuery } from './aws.mjs';
import { BUCKET_RE, REGION_RE } from './aws-names.mjs';

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const ATTEMPTS = 3;
const KEYS_PER_PAGE = 1000; // S3 never returns more per listing page
const DEFAULT_MAX_BYTES = 5_000_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NAMED_ENTITIES = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };

// One pass, so that `&amp;#34;` decodes to the text `&#34;` and not to a quote.
const decodeEntities = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(quot|apos|lt|gt|amp));/g, (match, dec, hex, name) => {
  if (name) return NAMED_ENTITIES[name];
  const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
  return code <= 0x10ffff ? String.fromCodePoint(code) : match;
});

const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeEntities(m[1]) : undefined;
};

// With encoding-type=url S3 writes a space as `+` and a literal plus as %2B.
const decodeKey = (s) => decodeURIComponent(s.replace(/\+/g, ' '));

const md5 = (body) => `"${createHash('md5').update(body).digest('hex')}"`;

// Reads a body without holding more than maxBytes plus one chunk.
async function readBody(res, maxBytes, operation) {
  const tooLarge = () => new AwsError(operation, res.status, 'TooLarge');
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function createS3({ bucket, region, credentials, fetchImpl = fetch, now = () => new Date(), sleep = defaultSleep, timeoutMs = 20000, signal }) {
  if (typeof bucket !== 'string' || !BUCKET_RE.test(bucket)) throw new AwsError('s3', 0, 'InvalidBucket');
  if (typeof region !== 'string' || !REGION_RE.test(region)) throw new AwsError('s3', 0, 'InvalidRegion');
  const host = `${bucket}.s3.${region}.amazonaws.com`;

  const runOver = (operation) => new AwsError(operation, 0, 'TimeLimit');

  // A wait that ends at once when the run-wide signal fires.
  async function wait(ms) {
    if (!signal) return sleep(ms);
    let onAbort;
    const aborted = new Promise((resolve) => { onAbort = resolve; signal.addEventListener('abort', onAbort, { once: true }); });
    try { await Promise.race([sleep(ms), aborted]); } finally { signal.removeEventListener('abort', onAbort); }
  }

  // One signed request with retries. Resolves with { status, etag, body, attempt } for any
  // answer that is final, including those the caller interprets (404, 412); the caller decides.
  async function send(operation, method, path, { query = {}, headers = {}, body = '', maxBytes = DEFAULT_MAX_BYTES, attempts = ATTEMPTS } = {}) {
    let last;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) throw runOver(operation);
      if (attempt > 1) {
        await wait(200 * (attempt - 1));
        if (signal?.aborted) throw runOver(operation);
      }
      const signed = signRequest({ method, host, path, query, headers, body, service: 's3', region, credentials, now: now() });
      delete signed.host; // set from the URL by fetch
      const qs = canonicalQuery(query);
      const limit = AbortSignal.timeout(timeoutMs);
      try {
        const res = await fetchImpl(`https://${host}${path}${qs ? `?${qs}` : ''}`, {
          method, headers: signed, body: method === 'PUT' ? body : undefined, redirect: 'manual',
          signal: signal ? AbortSignal.any([signal, limit]) : limit,
        });
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => {}); // the body is never read: let the connection go
          throw new AwsError(operation, res.status, 'Redirect');
        }
        const answer = { status: res.status, etag: res.headers.get('etag'), body: await readBody(res, maxBytes, operation), attempt };
        if (signal?.aborted) throw runOver(operation);
        if (!RETRY_STATUS.has(res.status)) return answer;
        last = answer;
      } catch (err) {
        if (err instanceof AwsError) throw err;
        if (signal?.aborted) throw runOver(operation);
        last = networkError(operation, err);
      }
    }
    if (last instanceof AwsError) throw last;
    throw failure(operation, last);
  }

  const failure = (operation, answer) =>
    new AwsError(operation, answer.status, safeCode(tag(answer.body.toString('utf8'), 'Code')));

  const pathOf = (operation, key) => {
    if (typeof key !== 'string' || key === '') throw new AwsError(operation, 0, 'InvalidKey');
    return `/${key}`;
  };

  const etagOf = (operation, res) => {
    if (!res.etag) throw new AwsError(operation, res.status, 'NoETag');
    return res.etag;
  };

  return {
    async get(key, { deniedIsMissing = false, maxBytes = DEFAULT_MAX_BYTES } = {}) {
      const res = await send('get', 'GET', pathOf('get', key), { maxBytes });
      if (res.status === 200) return { status: 'ok', body: res.body, etag: etagOf('get', res) };
      if (res.status === 404 || (deniedIsMissing && res.status === 403)) return { status: 'missing' };
      throw failure('get', res);
    },

    async put(key, body, { ifMatch, ifNoneMatch, contentType = 'application/octet-stream' } = {}) {
      const path = pathOf('put', key);
      const headers = { 'content-type': contentType };
      if (ifMatch !== undefined) headers['if-match'] = ifMatch;
      if (ifNoneMatch !== undefined) headers['if-none-match'] = ifNoneMatch;
      const res = await send('put', 'PUT', path, { headers, body });
      if (res.status === 200) return { status: 'ok', etag: etagOf('put', res) };
      if (res.status !== 412 && res.status !== 409) throw failure('put', res);
      // On a retry the 412 may be the answer to our own write, applied by an earlier attempt whose
      // answer was lost. If the object is exactly our body, the write happened.
      const conditional = ifMatch !== undefined || ifNoneMatch !== undefined;
      if (conditional && res.attempt > 1) {
        try {
          const back = await send('put', 'GET', path, { attempts: 1 });
          if (back.status === 200 && back.etag === md5(body)) return { status: 'ok', etag: back.etag };
        } catch (err) {
          if (signal?.aborted) throw err;
        }
      }
      return { status: 'conflict' };
    },

    async del(key) {
      const res = await send('del', 'DELETE', pathOf('del', key));
      if (res.status >= 200 && res.status < 300) return { status: 'ok' };
      throw failure('del', res);
    },

    async list(prefix, { maxKeys = 20000 } = {}) {
      if (typeof prefix !== 'string') throw new AwsError('list', 0, 'InvalidPrefix');
      const maxPages = Math.ceil(maxKeys / KEYS_PER_PAGE) + 1;
      const found = [];
      let token;
      let pages = 0;
      do {
        const query = { 'list-type': '2', prefix, 'encoding-type': 'url' };
        if (token) query['continuation-token'] = token;
        const res = await send('list', 'GET', '/', { query });
        if (res.status !== 200) throw failure('list', res);
        pages += 1;
        const xml = res.body.toString('utf8');
        try {
          for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
            const key = tag(m[1], 'Key');
            const etag = tag(m[1], 'ETag');
            const size = Number(tag(m[1], 'Size'));
            if (key === undefined || etag === undefined || !Number.isSafeInteger(size)) throw new Error('shape');
            found.push({ key: decodeKey(key), etag, size });
          }
        } catch {
          throw new AwsError('list', res.status, 'BadResponse');
        }
        if (found.length > maxKeys) throw new AwsError('list', 0, 'TooManyKeys');
        token = undefined;
        if (tag(xml, 'IsTruncated') === 'true') {
          token = tag(xml, 'NextContinuationToken');
          if (!token) throw new AwsError('list', res.status, 'BadListing');
          if (pages >= maxPages) throw new AwsError('list', 0, 'TooManyKeys');
        }
      } while (token);
      return found;
    },
  };
}
