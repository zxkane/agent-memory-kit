import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ApiError } from './errors.ts';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface Store {
  get(
    key: string,
    ifNoneMatch?: string,
  ): Promise<{ status: 'ok'; body: string; etag: string } | { status: 'missing' } | { status: 'not-modified' }>;
  put(
    key: string,
    body: string,
    cond: { ifMatch: string } | { ifNoneMatch: '*' } | null,
  ): Promise<{ status: 'ok'; etag: string } | { status: 'precondition-failed' }>;
}

function httpStatus(err: unknown): number | undefined {
  const meta = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata;
  return meta?.httpStatusCode;
}

function errorName(err: unknown): string | undefined {
  return (err as { name?: string } | null)?.name;
}

export function s3Store(bucket: string, client: S3Client = new S3Client({})): Store {
  return {
    async get(key, ifNoneMatch) {
      let out;
      try {
        out = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
            ...(ifNoneMatch !== undefined ? { IfNoneMatch: ifNoneMatch } : {}),
          }),
        );
      } catch (err) {
        const status = httpStatus(err);
        // Only a missing key reads as missing. NoSuchBucket is also a 404, and AccessDenied (what S3
        // answers for a missing key without s3:ListBucket) is an error, so the name is checked first.
        const name = errorName(err);
        if (name === 'NoSuchKey' || (status === 404 && name !== 'NoSuchBucket')) return { status: 'missing' };
        if (status === 304 || errorName(err) === 'NotModified') return { status: 'not-modified' };
        throw err;
      }
      if (out.ContentLength !== undefined && out.ContentLength > MAX_BODY_BYTES) {
        throw new Error('The stored object is larger than the 8 MB limit.');
      }
      if (!out.Body) throw new Error('The stored object has no body.');
      const bytes = await out.Body.transformToByteArray();
      if (bytes.length > MAX_BODY_BYTES) throw new Error('The stored object is larger than the 8 MB limit.');
      return { status: 'ok', body: new TextDecoder('utf-8').decode(bytes), etag: out.ETag ?? '' };
    },

    async put(key, body, cond) {
      const contentType = key.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/json';
      try {
        const out = await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            ...(cond && 'ifMatch' in cond ? { IfMatch: cond.ifMatch } : {}),
            ...(cond && 'ifNoneMatch' in cond ? { IfNoneMatch: cond.ifNoneMatch } : {}),
          }),
        );
        return { status: 'ok', etag: out.ETag ?? '' };
      } catch (err) {
        const status = httpStatus(err);
        if (status === 412 || status === 409) return { status: 'precondition-failed' };
        throw err;
      }
    },
  };
}

export async function update(
  store: Store,
  key: string,
  change: (current: string | null) => string,
  attempts = 5,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const current = await store.get(key);
    if (current.status === 'not-modified') throw new Error('Unexpected not-modified response.');
    const next = change(current.status === 'ok' ? current.body : null);
    const cond = current.status === 'ok' ? { ifMatch: current.etag } : ({ ifNoneMatch: '*' } as const);
    const result = await store.put(key, next, cond);
    if (result.status === 'ok') return;
  }
  throw new ApiError(409, 'conflict', 'The object was changed concurrently; retry the request.');
}
