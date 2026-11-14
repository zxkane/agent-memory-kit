import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

const root = new URL('..', import.meta.url);
const infraDir = new URL('infra/', root);
const files = [
  'sst.config.ts',
  ...readdirSync(infraDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => `infra/${f}`),
];
const read = (rel: string): string => readFileSync(new URL(rel, root), 'utf8');

describe('infrastructure source', () => {
  it('has the expected program files', () => {
    for (const f of ['sst.config.ts', 'infra/policies.ts', 'infra/storage.ts', 'infra/auth.ts', 'infra/api.ts', 'infra/workstation.ts']) {
      assert.ok(files.includes(f), f);
    }
  });

  it('builds the routes by iterating ROUTES', () => {
    const src = read('infra/api.ts');
    assert.match(src, /import\s*\{[^}]*\bROUTES\b[^}]*\}\s*from/);
    assert.match(src, /for\s*\(\s*const\s+\w+\s+of\s+ROUTES\s*\)|ROUTES\s*\.\s*(forEach|map)\s*\(/);
  });

  for (const [name, pattern] of [
    ['url: true', /url\s*:\s*true/],
    ['FunctionUrl', /FunctionUrl/i],
    ['authorizationType NONE', /authorizationType\s*:\s*["']NONE["']/],
    ['$default', /\$default/],
    ['a 12-digit number', /\b\d{12}\b/],
    ['a hard-coded region', /[a-z]{2}-[a-z]+-\d/],
  ] as const) {
    it(`contains no ${name}`, () => {
      for (const f of files) {
        assert.doesNotMatch(read(f), pattern, f);
      }
    });
  }

  it('forces the Node.js 24 runtime and arm64', () => {
    assert.match(read('sst.config.ts'), /\$transform\(\s*aws\.lambda\.Function[\s\S]*nodejs24\.x/);
    assert.match(read('infra/api.ts'), /arm64/);
  });

  it('requires AGENT_MEMORY_REGION', () => {
    assert.match(read('sst.config.ts'), /Set AGENT_MEMORY_REGION to the AWS region to deploy to\./);
  });

  const squash = (rel: string): string => read(rel).replace(/\s+/g, '');

  it('has exactly one route call, inside the ROUTES loop, with the JWT authorizer and a scope', () => {
    const src = squash('infra/api.ts');
    assert.equal((src.match(/\.route\(/g) ?? []).length, 1);
    assert.doesNotMatch(src, /\.routeUrl\(|\.routePrivate\(/);
    assert.equal((src.match(/\.addAuthorizer\(/g) ?? []).length, 1);
    const loop = src.match(/for\(const(\w+)ofROUTES\)\{(.*)\}constprefix/);
    assert.ok(loop, 'ROUTES loop');
    const body = loop[2];
    assert.equal((body.match(/\.route\(/g) ?? []).length, 1);
    assert.match(body, /auth:\{jwt:\{authorizer:authorizer\.id,scopes:\[`\$\{RESOURCE_SERVER\}\/\$\{\w+\.scope\}`\]/);
  });

  it('gives the function an explicit log group and an empty managed-policy list', () => {
    const src = squash('infra/api.ts');
    assert.match(src, /logging:\{logGroup:/);
    assert.doesNotMatch(src.match(/logging:\{[^}]*\}/)?.[0] ?? '', /retention/);
    assert.match(src, /role:\(?\w*\)?[^;]*managedPolicyArns=\[\]|managedPolicyArns=\[\]/);
    assert.match(src, /retentionInDays:30/);
  });

  it('sets the function role trust policy explicitly from trustPolicy()', () => {
    const src = squash('infra/api.ts');
    assert.match(src, /role:\(?\w*(:[\w.]+)?\)?(:[\w.]+)?=>\{[^]*args\.assumeRolePolicy=JSON\.stringify\(trustPolicy\(\)\)/);
    assert.match(src, /import\{[^}]*\btrustPolicy\b[^}]*\}from/);
  });

  it('has no :root principal in the SST program files', () => {
    for (const f of files) {
      assert.doesNotMatch(read(f), /:root\b/, f);
    }
  });

  it('makes the probe client scopes depend on the stage', () => {
    const src = squash('infra/auth.ts');
    assert.match(src, /name:"probe"[\s\S]*allowedOauthScopes:\$app\.stage===/);
  });

  it('sets explicitAuthFlows explicitly on both clients', () => {
    assert.equal((squash('infra/auth.ts').match(/explicitAuthFlows:\[\]/g) ?? []).length, 1);
  });

  it('expires noncurrent versions of index/ after one day and keeps the 90-day bucket-wide rule', () => {
    const src = squash('infra/storage.ts');
    assert.match(
      src,
      /id:"expire-old-versions-and-abandoned-uploads",status:"Enabled",filter:\{\},noncurrentVersionExpiration:\{noncurrentDays:90\}/,
    );
    assert.match(
      src,
      /id:"expire-index-snapshot-versions",status:"Enabled",filter:\{prefix:"index\/"\},noncurrentVersionExpiration:\{noncurrentDays:1,newerNoncurrentVersions:20\}/,
    );
    assert.equal((src.match(/noncurrentVersionExpiration/g) ?? []).length, 2);
  });

  it('replaces every underscore of the user pool id in the domain prefix', () => {
    assert.match(read('infra/auth.ts'), /id\.toLowerCase\(\)\.replaceAll\(\s*["']_["']\s*,\s*["']-["']\s*\)/);
  });

  it('logs the source IP', () => {
    assert.match(read('infra/api.ts'), /\$context\.identity\.sourceIp/);
  });

  it('creates the two workstation roles and their parameters only inside the branch that requires one of the two variables', () => {
    const src = squash('infra/workstation.ts');
    const branch = src.match(/if\(roleArns\.length>0\|\|githubSubjects\.length>0\)\{(.*)\}$/);
    assert.ok(branch, 'branch on the role ARNs');
    const body = branch[1];
    assert.equal((src.match(/newaws\.iam\.Role\(/g) ?? []).length, 2);
    assert.equal((body.match(/newaws\.iam\.Role\(/g) ?? []).length, 2);
    assert.equal((src.match(/newaws\.iam\.RolePolicy\(/g) ?? []).length, 2);
    assert.equal((body.match(/newaws\.iam\.RolePolicy\(/g) ?? []).length, 2);
    assert.equal((src.match(/newaws\.ssm\.Parameter\(/g) ?? []).length, 2);
    assert.equal((body.match(/newaws\.ssm\.Parameter\(/g) ?? []).length, 2);
    assert.match(src, /process\.env\.AGENT_MEMORY_WORKSTATION_ROLE_ARNS/);
    assert.equal((body.match(/maxSessionDuration:3600/g) ?? []).length, 2);
    assert.equal((body.match(/assumeRolePolicy:trustDocument/g) ?? []).length, 2);
    assert.match(body, /name:`\$\{\$app\.name\}-\$\{\$app\.stage\}-bridge`/);
    assert.match(body, /name:`\$\{\$app\.name\}-\$\{\$app\.stage\}-canary`/);
    assert.match(body, /prefix=`\/\$\{\$app\.name\}\/\$\{\$app\.stage\}\/mcp`/);
    assert.match(body, /name:`\$\{prefix\}\/bridge\/role-arn`/);
    assert.match(body, /name:`\$\{prefix\}\/canary\/role-arn`/);
    assert.match(src, /process\.env\.AGENT_MEMORY_GITHUB_SUBJECTS/);
    assert.match(src, /jobsTrustPolicy\(/);
    assert.doesNotMatch(src, /workstationTrustPolicy/);
    assert.doesNotMatch(src, /OpenIdConnectProvider/);
    assert.match(src, /getCallerIdentityOutput\(\)/);
    assert.match(src, /getPartitionOutput\(\)/);
    assert.doesNotMatch(src, /managedPolicyArns|aws\.iam\.RolePolicyAttachment/);
  });

  it('lists the canary parameters exactly as the canary reads them, and not the hub client', () => {
    const infra = read('infra/workstation.ts').match(/canaryParameterArns\s*=\s*\[([^\]]*)\]/);
    assert.ok(infra, 'parameter list in workstation.ts');
    const canary = new URL('../workstation/canary.mjs', root);
    const canaryList = readFileSync(canary, 'utf8').match(/const PARAMETERS\s*=\s*\[([^\]]*)\]/);
    assert.ok(canaryList, 'PARAMETERS in canary.mjs');
    const keys = (list: string): string[] => [...list.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
    const fromInfra = keys(infra[1] as string);
    const fromCanary = keys(canaryList[1] as string);
    assert.equal(fromInfra.length, 4);
    assert.deepEqual([...fromInfra].sort(), [...fromCanary].sort());
    for (const key of [...fromInfra, ...fromCanary]) assert.ok(!key.includes('hub'), key);
  });

  it('uses the same role ARN pattern in the policies and in the workstation jobs', () => {
    const pattern = /ROLE_ARN_RE\s*=\s*(\/.*\/)\s*;/;
    const inPolicies = read('infra/policies.ts').match(pattern);
    const inJobs = readFileSync(new URL('../workstation/lib/aws-names.mjs', root), 'utf8').match(pattern);
    assert.ok(inPolicies && inJobs, 'both patterns found');
    assert.equal(inPolicies[1], inJobs[1]);
  });

  it('keeps the workstation role variable out of the storage program and loads workstation.ts', () => {
    assert.doesNotMatch(read('infra/storage.ts'), /WORKSTATION_ROLE_ARNS/);
    assert.match(read('sst.config.ts'), /import\("\.\/infra\/workstation\.ts"\)/);
  });
});
