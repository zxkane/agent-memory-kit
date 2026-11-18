// Preloaded into a spawned driver (NODE_OPTIONS=--import): `fetch` to an S3 host is answered by the
// fake bucket of fake-s3.mjs, kept in the file FAKE_S3_FILE (JSON: key -> { body: base64, etag }).
// The file is read before and written after every request, so a test, or a model client that
// stands in for an agent, can change the bucket while the driver runs and read it afterwards.
// Each request is appended to FAKE_S3_LOG (JSON lines) when that is set.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createFakeS3 } from './fake-s3.mjs';

const file = process.env.FAKE_S3_FILE;
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (!/\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(u.hostname)) return realFetch(url, init);
  const fake = createFakeS3();
  for (const [key, o] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) {
    fake.objects.set(key, { body: Buffer.from(o.body, 'base64'), etag: o.etag });
  }
  const res = await fake.fetch(url, init);
  const objects = Object.fromEntries([...fake.objects].map(([key, o]) => [key, { body: o.body.toString('base64'), etag: o.etag }]));
  writeFileSync(file, JSON.stringify(objects));
  if (process.env.FAKE_S3_LOG) {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    appendFileSync(process.env.FAKE_S3_LOG, `${JSON.stringify({
      method: init.method ?? 'GET', key: decodeURIComponent(u.pathname.slice(1)), status: res.status,
      ifMatch: headers['if-match'] ?? null, ifNoneMatch: headers['if-none-match'] ?? null,
    })}\n`);
  }
  return res;
};
