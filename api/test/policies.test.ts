import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bridgeRolePolicy,
  bucketPolicy,
  canaryRolePolicy,
  functionPolicy,
  logsPolicy,
  jobsTrustPolicy,
  trustPolicy,
  workstationTrustPolicy,
} from '../infra/policies.ts';

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

  it('allows exactly GetObject on mem, index, agents, and PutObject on agents and index/agents.json', () => {
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

  it('has no delete, no list, no wildcard action, no wildcard resource and no put under mem or other index keys', () => {
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
  it('holds only the TLS deny', () => {
    const statements = bucketPolicy(BUCKET).Statement as Statement[];
    assert.equal(statements.length, 1);
    const [s] = statements;
    assert.equal(s.Effect, 'Deny');
    assert.equal(s.Principal, '*');
    assert.deepEqual(asList(s.Action), ['s3:*']);
    assert.deepEqual(asList(s.Resource).sort(), [BUCKET, `${BUCKET}/*`].sort());
    assert.deepEqual(s.Condition, { Bool: { 'aws:SecureTransport': 'false' } });
  });
});

describe('bridgeRolePolicy', () => {
  const policy = bridgeRolePolicy(BUCKET);
  const statements = policy.Statement as Statement[];

  it('holds exactly five allow statements, without a principal', () => {
    assert.deepEqual(statements, [
      {
        Effect: 'Allow',
        Action: ['s3:PutObject', 's3:DeleteObject'],
        Resource: [`${BUCKET}/mem/*`],
      },
      {
        Effect: 'Allow',
        Action: ['s3:PutObject'],
        Resource: [`${BUCKET}/index/mem.json`],
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject'],
        Resource: [`${BUCKET}/index/bridge.json`],
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject'],
        Resource: [`${BUCKET}/agents/*`],
      },
      {
        Effect: 'Allow',
        Action: ['s3:ListBucket'],
        Resource: [BUCKET],
        Condition: { StringLike: { 's3:prefix': ['mem/*', 'agents/*'] } },
      },
    ]);
  });

  it('gives no write or delete on index/agents.json or agents/, no delete under index/, and no index/* resource', () => {
    for (const s of statements) {
      assert.equal(s.Principal, undefined);
      const actions = asList(s.Action);
      for (const r of asList(s.Resource)) {
        assert.notEqual(r, `${BUCKET}/index/*`);
        assert.notEqual(r, `${BUCKET}/*`);
        assert.notEqual(r, '*');
        if (r.startsWith(`${BUCKET}/index/`)) {
          assert.ok(!actions.includes('s3:DeleteObject'), r);
        }
        if (r === `${BUCKET}/index/agents.json` || r.startsWith(`${BUCKET}/agents/`)) {
          assert.ok(!actions.includes('s3:PutObject'), r);
          assert.ok(!actions.includes('s3:DeleteObject'), r);
        }
      }
    }
  });
});

describe('canaryRolePolicy', () => {
  const PREFIX = 'arn:aws:ssm:region-x:123456789012:parameter/agent-memory/dev/mcp';
  const ARNS = ['gateway/url', 'cognito/token-endpoint', 'cognito/probe/client-id', 'cognito/probe/client-secret'].map(
    (k) => `${PREFIX}/${k}`,
  );

  it('allows ssm:GetParameter on exactly the given parameters', () => {
    assert.deepEqual(canaryRolePolicy(ARNS).Statement, [
      { Effect: 'Allow', Action: ['ssm:GetParameter'], Resource: ARNS },
    ]);
  });

  it('does not name the hub client secret or a wildcard', () => {
    const text = JSON.stringify(canaryRolePolicy(ARNS));
    assert.ok(!text.includes('hub'));
    assert.ok(!text.includes('*'));
  });
});

describe('workstationTrustPolicy', () => {
  it('lets only the given roles assume the role', () => {
    assert.deepEqual(workstationTrustPolicy([ROLE_A, ROLE_B]), {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { AWS: [ROLE_A, ROLE_B] }, Action: 'sts:AssumeRole' }],
    });
  });

  it('rejects an empty list', () => {
    assert.throws(() => workstationTrustPolicy([]), /at least one/i);
  });

  it('throws on a malformed role ARN', () => {
    for (const bad of [
      'arn:aws:iam::123:role/x',
      'arn:aws:iam::123456789012:user/x',
      'arn:aws:iam::123456789012:root',
      'arn:aws:iam::123456789012:role/',
      '*',
      'arn:aws:iam::123456789012:role/*',
      'arn:aws:iam::123456789012:role/x y',
      'arn:aws:iam::123456789012:role//name',
      'arn:aws:iam::123456789012:role/a//b',
      'arn:aws:iam::123456789012:role/a/',
    ]) {
      assert.throws(() => workstationTrustPolicy([ROLE_A, bad]), /role/i, bad);
    }
  });

  it('accepts a plain name and a path', () => {
    for (const ok of ['arn:aws:iam::123456789012:role/name', 'arn:aws:iam::123456789012:role/path/name']) {
      assert.doesNotThrow(() => workstationTrustPolicy([ok]), ok);
    }
  });
});

describe('jobsTrustPolicy', () => {
  const PROVIDER = 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com';
  const SUBJECT = 'repo:o/r:ref:refs/heads/main';
  const roleStatement = { Effect: 'Allow', Principal: { AWS: [ROLE_A, ROLE_B] }, Action: 'sts:AssumeRole' };
  const githubStatement = (subjects: string[]) => ({
    Effect: 'Allow',
    Principal: { Federated: PROVIDER },
    Action: 'sts:AssumeRoleWithWebIdentity',
    Condition: {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': subjects,
      },
    },
  });

  it('for roles only returns exactly the workstation document', () => {
    const doc = jobsTrustPolicy({ roleArns: [ROLE_A, ROLE_B], githubSubjects: [] });
    assert.deepEqual(doc, workstationTrustPolicy([ROLE_A, ROLE_B]));
    assert.equal(JSON.stringify(doc), JSON.stringify(workstationTrustPolicy([ROLE_A, ROLE_B])));
    assert.deepEqual(doc, { Version: '2012-10-17', Statement: [roleStatement] });
  });

  it('for subjects only returns one GitHub statement with the audience condition', () => {
    assert.deepEqual(
      jobsTrustPolicy({ roleArns: [], githubSubjects: [SUBJECT], githubProviderArn: PROVIDER }),
      { Version: '2012-10-17', Statement: [githubStatement([SUBJECT])] },
    );
  });

  it('for both returns the role statement then the GitHub statement', () => {
    const second = 'repo:o/r:ref:refs/heads/release/1';
    assert.deepEqual(
      jobsTrustPolicy({ roleArns: [ROLE_A, ROLE_B], githubSubjects: [SUBJECT, second], githubProviderArn: PROVIDER }),
      { Version: '2012-10-17', Statement: [roleStatement, githubStatement([SUBJECT, second])] },
    );
  });

  it('refuses two empty lists', () => {
    assert.throws(() => jobsTrustPolicy({ roleArns: [], githubSubjects: [] }), /at least one/i);
  });

  it('refuses subjects that are not an exact branch', () => {
    for (const bad of [
      'repo:o/*:ref:refs/heads/main',
      'repo:o/r:*',
      'repo:o/r:ref:refs/heads/*',
      'repo:o/r:ref:refs/heads/ma?n',
      'repo:o/?:ref:refs/heads/main',
      'repo:o/r:pull_request',
      'repo:o/r:ref:refs/tags/v1',
      'repo:o/r:environment:',
      'repo:o/r:environment:production',
      'repo:o:ref:refs/heads/main',
      'repo:o/r:ref:refs/heads/',
      'o/r:ref:refs/heads/main',
      '',
    ]) {
      assert.throws(
        () => jobsTrustPolicy({ roleArns: [], githubSubjects: [SUBJECT, bad], githubProviderArn: PROVIDER }),
        /subject/i,
        bad,
      );
    }
  });

  it('accepts branch names with slashes, dots and dashes', () => {
    for (const ok of ['repo:o/r:ref:refs/heads/feature/x', 'repo:o-1/r_2.x:ref:refs/heads/rel-1.0']) {
      assert.doesNotThrow(() => jobsTrustPolicy({ roleArns: [], githubSubjects: [ok], githubProviderArn: PROVIDER }), ok);
    }
  });

  it('refuses subjects without a provider ARN, and a provider ARN of another issuer', () => {
    assert.throws(() => jobsTrustPolicy({ roleArns: [], githubSubjects: [SUBJECT] }), /provider/i);
    for (const bad of [
      'arn:aws:iam::123456789012:oidc-provider/example.com',
      'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com.evil.example',
      'arn:aws:iam::123456789012:role/token.actions.githubusercontent.com',
      'arn:aws:iam::123:oidc-provider/token.actions.githubusercontent.com',
      '*',
    ]) {
      assert.throws(
        () => jobsTrustPolicy({ roleArns: [], githubSubjects: [SUBJECT], githubProviderArn: bad }),
        /provider/i,
        bad,
      );
    }
  });

  it('still validates the role ARNs', () => {
    assert.throws(() => jobsTrustPolicy({ roleArns: ['*'], githubSubjects: [SUBJECT], githubProviderArn: PROVIDER }), /role/i);
  });
});

describe('logsPolicy', () => {
  const LOG_GROUP = 'arn:aws:logs:region-x:123456789012:log-group:/aws/lambda/example';
  const policy = logsPolicy(LOG_GROUP);
  const statements = policy.Statement as Statement[];

  it('allows exactly CreateLogStream and PutLogEvents on the group streams', () => {
    const pairs = statements.flatMap((s) => {
      assert.equal(s.Effect, 'Allow');
      return asList(s.Action).flatMap((a) => asList(s.Resource).map((r) => `${a} ${r}`));
    });
    assert.deepEqual(
      pairs.sort(),
      [`logs:CreateLogStream ${LOG_GROUP}:*`, `logs:PutLogEvents ${LOG_GROUP}:*`].sort(),
    );
  });

  it('has no CreateLogGroup and no bare wildcard resource', () => {
    assert.ok(!JSON.stringify(policy).includes('CreateLogGroup'));
    for (const s of statements) {
      for (const r of asList(s.Resource)) assert.notEqual(r, '*');
    }
  });
});

describe('trustPolicy', () => {
  const policy = trustPolicy();
  const statements = policy.Statement as Statement[];

  it('has exactly one statement', () => {
    assert.equal(statements.length, 1);
    assert.equal(statements[0].Effect, 'Allow');
  });

  it('trusts only the Lambda service, with no AWS key and no wildcard', () => {
    assert.deepEqual(statements[0].Principal, { Service: 'lambda.amazonaws.com' });
    const text = JSON.stringify(policy);
    assert.ok(!text.includes('"AWS"'));
    assert.ok(!text.includes('*'));
    assert.ok(!text.includes(':root'));
  });

  it('allows only sts:AssumeRole', () => {
    assert.deepEqual(asList(statements[0].Action), ['sts:AssumeRole']);
  });
});
