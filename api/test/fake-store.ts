import type { Store } from '../src/store.ts';

type Get = Awaited<ReturnType<Store['get']>>;
type Put = Awaited<ReturnType<Store['put']>>;

export type FakeStore = Store & {
  objects: Map<string, { body: string; etag: string }>;
  gets: { key: string; ifNoneMatch?: string }[];
  beforePut?: (key: string) => void;
};

/**
 * noList models a role without s3:ListBucket: S3 then answers a get of a missing key with
 * 403 AccessDenied instead of 404.
 */
export function fakeStore(initial: Record<string, string> = {}, opts: { noList?: boolean } = {}): FakeStore {
  let counter = 0;
  const objects = new Map<string, { body: string; etag: string }>();
  const nextEtag = () => `"etag-${++counter}"`;
  for (const [key, body] of Object.entries(initial)) objects.set(key, { body, etag: nextEtag() });

  const store: FakeStore = {
    objects,
    gets: [],
    async get(key, ifNoneMatch): Promise<Get> {
      store.gets.push({ key, ifNoneMatch });
      const found = objects.get(key);
      if (!found) {
        if (opts.noList) {
          throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
        }
        return { status: 'missing' };
      }
      if (ifNoneMatch !== undefined && ifNoneMatch === found.etag) return { status: 'not-modified' };
      return { status: 'ok', body: found.body, etag: found.etag };
    },
    async put(key, body, cond): Promise<Put> {
      store.beforePut?.(key);
      const found = objects.get(key);
      if (cond && 'ifNoneMatch' in cond && found) return { status: 'precondition-failed' };
      if (cond && 'ifMatch' in cond && (!found || found.etag !== cond.ifMatch)) {
        return { status: 'precondition-failed' };
      }
      const etag = nextEtag();
      objects.set(key, { body, etag });
      return { status: 'ok', etag };
    },
  };
  return store;
}
