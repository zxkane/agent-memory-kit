import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bucketPolicy, functionPolicy } from '../infra/policies.ts';

const BUCKET = 'arn:aws:s3:::example-bucket';
const ROLE_A = 'arn:aws:iam::123456789012:role/bridge-a';
const ROLE_B = 'arn:aws:iam::123456789012:role/path/bridge-b';

type Statement = {
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Principal?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
};

const asList = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);

describe('functionPolicy', () => {
  const policy = functionPolicy(BUCKET);
  const statements = policy.Statement as Statement[];

  it('allows exactly GetObject on mem, index, agents and PutObject on agents and index/agents.json', () => {
    const pairs = statements.flatMap((s) => {
      assert.equal(s.Effect, 'Allow');
      return asList(s.Action).flatMap((a) => asList(s.Resource).map((r) => `${a} ${r}`));
    });
    assert.deepEqual(
      pairs.sort(),
      [
        `s3:GetObject ${BUCKET}/mem/*`,
        `s3:GetObject ${BUCKET}/index/*`,
        `s3:GetObject ${BUCKET}/agents/*`,
        `s3:PutObject ${BUCKET}/agents/*`,
        `s3:PutObject ${BUCKET}/index/agents.json`,
      ].sort(),
    );
  });

  it('has no delete, no list, no wildcard resource and no put under mem or other index keys', () => {
    const text = JSON.stringify(policy);
    assert.ok(!text.includes('DeleteObject'));
    assert.ok(!text.includes('ListBucket'));
    assert.ok(!text.includes('s3:*'));
    for (const s of statements) {
      for (const r of asList(s.Resource)) {
        assert.notEqual(r, '*');
        if (asList(s.Action).includes('s3:PutObject')) {
          assert.ok(r === `${BUCKET}/agents/*` || r === `${BUCKET}/index/agents.json`, r);
        }
      }
    }
  });
});

describe('bucketPolicy', () => {
  it('without roles holds only the TLS deny', () => {
    const statements = bucketPolicy(BUCKET, []).Statement as Statement[];
    assert.equal(statements.length, 1);
    const [s] = statements;
    assert.equal(s.Effect, 'Deny');
    assert.equal(s.Principal, '*');
    assert.deepEqual(asList(s.Action), ['s3:*']);
    assert.deepEqual(asList(s.Resource).sort(), [BUCKET, `${BUCKET}/*`].sort());
    assert.deepEqual(s.Condition, { Bool: { 'aws:SecureTransport': 'false' } });
  });

  it('with two roles grants the bridge access to both principals', () => {
    const statements = bucketPolicy(BUCKET, [ROLE_A, ROLE_B]).Statement as Statement[];
    const allows = statements.filter((s) => s.Effect === 'Allow');
    assert.equal(allows.length, 3);
    for (const s of allows) {
      assert.deepEqual(s.Principal, { AWS: [ROLE_A, ROLE_B] });
    }
    const pairs = allows
      .flatMap((s) => asList(s.Action).flatMap((a) => asList(s.Resource).map((r) => `${a} ${r}`)))
      .sort();
    assert.deepEqual(
      pairs,
      [
        `s3:GetObject ${BUCKET}/mem/*`,
        `s3:PutObject ${BUCKET}/mem/*`,
        `s3:DeleteObject ${BUCKET}/mem/*`,
        `s3:GetObject ${BUCKET}/index/*`,
        `s3:PutObject ${BUCKET}/index/*`,
        `s3:DeleteObject ${BUCKET}/index/*`,
        `s3:GetObject ${BUCKET}/agents/*`,
        `s3:ListBucket ${BUCKET}`,
      ].sort(),
    );
    const list = allows.find((s) => asList(s.Action).includes('s3:ListBucket'));
    assert.deepEqual(list?.Condition, {
      StringLike: { 's3:prefix': ['mem/*', 'index/*', 'agents/*'] },
    });
    assert.equal(statements.filter((s) => s.Effect === 'Deny').length, 1);
  });

  it('throws on a malformed role ARN', () => {
    for (const bad of [
      'arn:aws:iam::123:role/x',
      'arn:aws:iam::123456789012:user/x',
      'arn:aws:iam::123456789012:role/',
      '*',
      'arn:aws:iam::123456789012:role/x y',
    ]) {
      assert.throws(() => bucketPolicy(BUCKET, [bad]), /role/i, bad);
    }
  });
});
