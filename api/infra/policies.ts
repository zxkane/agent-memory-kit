// Pure policy documents. No SST or Pulumi imports, so tests and the normal
// type check can load this file without the generated platform types.

export type PolicyStatement = {
  Effect: 'Allow' | 'Deny';
  Principal?: '*';
  Action: string[];
  Resource: string[];
  Condition?: Record<string, Record<string, string | string[]>>;
};

export type PolicyDocument = {
  Version: '2012-10-17';
  Statement: PolicyStatement[];
};

// Every path segment and the role name must be non-empty.
const ROLE_ARN_RE = /^arn:aws[a-z-]*:iam::\d{12}:role\/([\w+=,.@-]+\/)*[\w+=,.@-]+$/;

/**
 * The function's whole permission set. No delete and no list: without s3:ListBucket S3 answers a
 * get of a missing key with 403, which s3Store.get reads as missing (see store.ts).
 */
export function functionPolicy(bucketArn: string): PolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:GetObject'],
        Resource: [`${bucketArn}/mem/*`, `${bucketArn}/index/*`, `${bucketArn}/agents/*`],
      },
      {
        Effect: 'Allow',
        Action: ['s3:PutObject'],
        Resource: [`${bucketArn}/agents/*`, `${bucketArn}/index/agents.json`],
      },
    ],
  };
}

/**
 * The function's log permissions, kept beside functionPolicy. The log group is
 * created by the deployment, so there is no CreateLogGroup.
 */
export function logsPolicy(logGroupArn: string): PolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: [`${logGroupArn}:*`],
      },
    ],
  };
}

/**
 * The function role's trust policy: the Lambda service and nothing else. SST would otherwise
 * also trust the whole account, so the deployment sets this explicitly.
 */
export function trustPolicy() {
  return {
    Version: '2012-10-17' as const,
    Statement: [
      {
        Effect: 'Allow' as const,
        Principal: { Service: 'lambda.amazonaws.com' },
        Action: 'sts:AssumeRole',
      },
    ],
  };
}

/** The bucket policy: the TLS-only deny and nothing else. The workstation roles hold their grants in their own policies. */
export function bucketPolicy(bucketArn: string): PolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Deny',
        Principal: '*',
        Action: ['s3:*'],
        Resource: [bucketArn, `${bucketArn}/*`],
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      },
    ],
  };
}

/**
 * The bridge role's whole permission set. It needs only these objects, and only the actions it
 * uses. It writes notes and their snapshot but never reads them back from the bucket (it compares
 * the listing's ETags); it reads its own record index/bridge.json, and the agent notes under
 * agents/. A read of index/bridge.json before it exists answers 403 (the role has no list
 * permission there), which the bridge treats as "no record" by design. The list permission names
 * prefixes so that listing cannot reveal other keys, and index/ has no delete and no wildcard
 * because the API alone writes index/agents.json.
 */
export function bridgeRolePolicy(bucketArn: string): PolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['s3:PutObject', 's3:DeleteObject'],
        Resource: [`${bucketArn}/mem/*`],
      },
      {
        Effect: 'Allow',
        Action: ['s3:PutObject'],
        Resource: [`${bucketArn}/index/mem.json`],
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject'],
        Resource: [`${bucketArn}/index/bridge.json`],
      },
      {
        Effect: 'Allow',
        Action: ['s3:GetObject'],
        Resource: [`${bucketArn}/agents/*`],
      },
      {
        Effect: 'Allow',
        Action: ['s3:ListBucket'],
        Resource: [bucketArn],
        Condition: { StringLike: { 's3:prefix': ['mem/*', 'agents/*'] } },
      },
    ],
  };
}

/** The canary role's whole permission set: read exactly the parameters its checks use. */
export function canaryRolePolicy(parameterArns: string[]): PolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: ['ssm:GetParameter'], Resource: parameterArns }],
  };
}

const SUBJECT_RE = /^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+:ref:refs\/heads\/[A-Za-z0-9._\/-]+$/;
const GITHUB_PROVIDER_ARN_RE = /^arn:aws[a-z-]*:iam::\d{12}:oidc-provider\/token\.actions\.githubusercontent\.com$/;
const GITHUB_OIDC = 'token.actions.githubusercontent.com';

/**
 * The trust policy of a workstation role: the given IAM roles, and the GitHub Actions jobs whose
 * subject is named exactly (one branch of one repository; an environment subject would not be
 * bound to a branch), through the account's existing GitHub OIDC provider. Each kind that is
 * non-empty gets one statement.
 */
export function jobsTrustPolicy(input: { roleArns: string[]; githubSubjects: string[]; githubProviderArn?: string }) {
  const { roleArns, githubSubjects, githubProviderArn } = input;
  if (roleArns.length === 0 && githubSubjects.length === 0) {
    throw new Error('Give at least one workstation role ARN or GitHub subject.');
  }
  for (const arn of roleArns) {
    if (!ROLE_ARN_RE.test(arn)) {
      throw new Error('Each workstation role ARN must be an IAM role ARN.');
    }
  }
  for (const subject of githubSubjects) {
    if (!SUBJECT_RE.test(subject)) {
      throw new Error('Each GitHub subject must be repo:<owner>/<repository>:ref:refs/heads/<branch>.');
    }
  }
  if (githubSubjects.length > 0 && (githubProviderArn === undefined || !GITHUB_PROVIDER_ARN_RE.test(githubProviderArn))) {
    throw new Error('GitHub subjects need the ARN of the account\'s GitHub OIDC provider.');
  }
  const statements: Array<Record<string, unknown>> = [];
  if (roleArns.length > 0) {
    statements.push({ Effect: 'Allow', Principal: { AWS: roleArns }, Action: 'sts:AssumeRole' });
  }
  if (githubSubjects.length > 0) {
    statements.push({
      Effect: 'Allow',
      Principal: { Federated: githubProviderArn },
      Action: 'sts:AssumeRoleWithWebIdentity',
      Condition: {
        StringEquals: {
          [`${GITHUB_OIDC}:aud`]: 'sts.amazonaws.com',
          [`${GITHUB_OIDC}:sub`]: githubSubjects,
        },
      },
    });
  }
  return { Version: '2012-10-17' as const, Statement: statements };
}

/** The trust policy of a workstation role for IAM roles only. */
export function workstationTrustPolicy(roleArns: string[]) {
  return jobsTrustPolicy({ roleArns, githubSubjects: [] });
}
