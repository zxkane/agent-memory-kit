import { createHash } from 'node:crypto';

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const urlEncode = (s) => encodeURIComponent(s).replace(/%20/g, '+');
const quotedMd5 = (body) => `"${createHash('md5').update(body).digest('hex')}"`;

const errorResponse = (status, code) =>
  new Response(`<Error><Code>${code}</Code><Message>fake</Message></Error>`, { status });

// An in-memory stand-in for one bucket, enough of the S3 protocol for the client's calls.
export function createFakeS3({ pageSize = 1000 } = {}) {
  const objects = new Map();
  const requests = [];
  let failures = [];
  let hook = null;

  function serve(method, key, query, headers, body) {
    if (method === 'GET' && key === '') {
      const prefix = query.get('prefix') ?? '';
      const after = query.has('continuation-token')
        ? Buffer.from(query.get('continuation-token'), 'base64').toString('utf8').slice('after:'.length) : null;
      // UTF-8 byte order, as S3 sorts.
      const byBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(byBytes)
        .filter((k) => after === null || byBytes(k, after) > 0);
      const page = keys.slice(0, pageSize);
      const more = keys.length > page.length;
      const contents = page.map((k) => {
        const o = objects.get(k);
        return `<Contents><Key>${xmlEscape(urlEncode(k))}</Key><ETag>${xmlEscape(o.etag)}</ETag><Size>${o.body.length}</Size></Contents>`;
      }).join('');
      const token = more ? Buffer.from(`after:${page.at(-1)}`).toString('base64') : '';
      const xml = `<ListBucketResult><IsTruncated>${more}</IsTruncated>${contents}`
        + `${more ? `<NextContinuationToken>${xmlEscape(token)}</NextContinuationToken>` : ''}</ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }
    if (method === 'GET') {
      const o = objects.get(key);
      return o ? new Response(o.body, { status: 200, headers: { etag: o.etag } }) : errorResponse(404, 'NoSuchKey');
    }
    if (method === 'PUT') {
      const current = objects.get(key);
      if (headers['if-none-match'] !== undefined && headers['if-none-match'] !== '*') return errorResponse(501, 'NotImplemented');
      if (headers['if-none-match'] === '*' && current) return errorResponse(412, 'PreconditionFailed');
      if (headers['if-match'] !== undefined) {
        if (!current) return errorResponse(404, 'NoSuchKey');
        if (current.etag !== headers['if-match']) return errorResponse(412, 'PreconditionFailed');
      }
      const etag = quotedMd5(body);
      objects.set(key, { body, etag });
      return new Response(null, { status: 200, headers: { etag } });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return errorResponse(405, 'MethodNotAllowed');
  }

  async function fakeFetch(url, init = {}) {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const key = decodeURIComponent(u.pathname.slice(1));
    requests.push({ method, url: String(url), key, query: Object.fromEntries(u.searchParams), headers });
    if (hook) hook({ method, key });
    if (!headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')) return errorResponse(403, 'AccessDenied');
    if (failures.length > 0) {
      const status = failures.shift();
      return errorResponse(status, 'ServiceUnavailable');
    }
    const body = init.body === undefined ? Buffer.alloc(0) : Buffer.from(init.body);
    return serve(method, key, u.searchParams, headers, body);
  }

  return {
    fetch: fakeFetch,
    objects,
    requests,
    failNext(count, status) { failures = Array(count).fill(status); },
    onRequest(fn) { hook = fn; },
  };
}
