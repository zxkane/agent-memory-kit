// Pure policy documents. No SST or Pulumi imports, so tests and the normal
// type check can load this file without the generated platform types.

export type PolicyStatement = {
  Effect: 'Allow' | 'Deny';
  Principal?: '*' | { AWS: string[] };
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

/** TLS-only deny, plus the workstation bridge roles when given. */
export function bucketPolicy(bucketArn: string, workstationRoleArns: string[]): PolicyDocument {
  for (const arn of workstationRoleArns) {
    if (!ROLE_ARN_RE.test(arn)) {
      throw new Error('Each workstation role ARN must be an IAM role ARN.');
    }
  }
  const statements: PolicyStatement[] = [
    {
      Effect: 'Deny',
      Principal: '*',
      Action: ['s3:*'],
      Resource: [bucketArn, `${bucketArn}/*`],
      Condition: { Bool: { 'aws:SecureTransport': 'false' } },
    },
  ];
  if (workstationRoleArns.length > 0) {
    const principal = { AWS: workstationRoleArns };
    statements.push(
      {
        Effect: 'Allow',
        Principal: principal,
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        Resource: [`${bucketArn}/mem/*`, `${bucketArn}/index/*`],
      },
      {
        Effect: 'Allow',
        Principal: principal,
        Action: ['s3:GetObject'],
        Resource: [`${bucketArn}/agents/*`],
      },
      {
        Effect: 'Allow',
        Principal: principal,
        Action: ['s3:ListBucket'],
        Resource: [bucketArn],
        Condition: { StringLike: { 's3:prefix': ['mem/*', 'index/*', 'agents/*'] } },
      },
    );
  }
  return { Version: '2012-10-17', Statement: statements };
}
