import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// infra/mode.ts also reads process.env when it is loaded; load it with the variable unset.
delete process.env.AGENT_MEMORY_INVOKER_ROLE_ARNS;
delete process.env.AGENT_MEMORY_WORKSTATION_ROLE_ARNS;
delete process.env.AGENT_MEMORY_GITHUB_SUBJECTS;
delete process.env.AGENT_MEMORY_ORGANIZER_ROLE_ARNS;
delete process.env.AGENT_MEMORY_ORGANIZER_GITHUB_SUBJECTS;
delete process.env.AGENT_MEMORY_ORGANIZER_GITHUB_WORKFLOW_REFS;
delete process.env.AGENT_MEMORY_PERMISSIONS_BOUNDARY_ARN;
const { parseDeployMode } = await import('../infra/mode.ts');

const ROLE_A = 'arn:aws:iam::123456789012:role/gateway-a';
const ROLE_B = 'arn:aws:iam::123456789012:role/path/gateway-b';

describe('parseDeployMode', () => {
  it('is the HTTP deployment when the variable is not set or holds only blanks', () => {
    for (const env of [{}, { AGENT_MEMORY_INVOKER_ROLE_ARNS: '' }, { AGENT_MEMORY_INVOKER_ROLE_ARNS: ' , ' }]) {
      assert.deepEqual(parseDeployMode(env), { direct: false, invokerRoleArns: [], workstationRoleArns: [], githubSubjects: [], organizerRoleArns: [], organizerGithubSubjects: [], organizerGithubWorkflowRefs: [], permissionsBoundaryArn: null });
    }
  });

  it('is direct invocation when roles are given, trimmed, without empty entries or duplicates', () => {
    const mode = parseDeployMode({ AGENT_MEMORY_INVOKER_ROLE_ARNS: ` ${ROLE_A}, ,${ROLE_B},${ROLE_A}` });
    assert.deepEqual(mode, { direct: true, invokerRoleArns: [ROLE_A, ROLE_B], workstationRoleArns: [], githubSubjects: [], organizerRoleArns: [], organizerGithubSubjects: [], organizerGithubWorkflowRefs: [], permissionsBoundaryArn: null });
  });

  it('refuses anything that is not an IAM role ARN, without repeating the entry', () => {
    for (const bad of [
      '*',
      'lambda.amazonaws.com',
      'arn:aws:iam::123456789012:root',
      'arn:aws:iam::123456789012:user/someone',
      'arn:aws:iam::123456789012:role/*',
      'arn:aws:iam::*:role/gateway',
      `${ROLE_A},arn:aws:iam::123456789012:role/`,
    ]) {
      assert.throws(
        () => parseDeployMode({ AGENT_MEMORY_INVOKER_ROLE_ARNS: bad }),
        (error: Error) => /AGENT_MEMORY_INVOKER_ROLE_ARNS/.test(error.message) && !error.message.includes(bad.split(',').pop()!),
        bad,
      );
    }
  });

  it('reads the workstation roles and the GitHub subjects: trimmed, without empty entries or duplicates', () => {
    const subject = 'repo:example-owner/example-repo:ref:refs/heads/main';
    const mode = parseDeployMode({
      AGENT_MEMORY_WORKSTATION_ROLE_ARNS: ` ${ROLE_A}, ,${ROLE_B},${ROLE_A}`,
      AGENT_MEMORY_GITHUB_SUBJECTS: ` ${subject},,${subject}`,
    });
    assert.deepEqual(mode.workstationRoleArns, [ROLE_A, ROLE_B]);
    assert.deepEqual(mode.githubSubjects, [subject]);
    assert.equal(mode.direct, false);
  });

  it('reads immutable GitHub subjects, alone or mixed with a classic one', () => {
    const immutable = 'repo:example-owner@100/example-repository@200:ref:refs/heads/main';
    const classic = 'repo:example-owner/example-repo:ref:refs/heads/main';
    const mode = parseDeployMode({ AGENT_MEMORY_GITHUB_SUBJECTS: `${classic}, ${immutable}` });
    assert.deepEqual(mode.githubSubjects, [classic, immutable]);
  });

  it('refuses a half-immutable or malformed immutable GitHub subject', () => {
    for (const bad of [
      'repo:o@1/r:ref:refs/heads/main',
      'repo:o/r@2:ref:refs/heads/main',
      'repo:o@/r@2:ref:refs/heads/main',
      'repo:o@1/r@2:environment:production',
      'repo:o@1/r@2:ref:refs/heads/ma?n',
      'repo:o@1/r@2:ref:refs/heads//main',
      'repo:o@1/r@2:ref:refs/heads/a//b',
      'repo:o@1/r@2:ref:refs/heads/main/',
      'repo:o/r:ref:refs/heads//main',
      'repo:o/r:ref:refs/heads/a//b',
      'repo:o/r:ref:refs/heads/main/',
    ]) {
      assert.throws(
        () => parseDeployMode({ AGENT_MEMORY_GITHUB_SUBJECTS: bad }),
        (error: Error) => error.message.includes('AGENT_MEMORY_GITHUB_SUBJECTS') && !error.message.includes(bad),
        bad,
      );
    }
  });

  it('reads the organizer\'s workflow files, which need its GitHub subjects', () => {
    const subject = 'repo:example-owner@100/example-mirror@300:ref:refs/heads/main';
    const workflow = 'example-owner/example-mirror/.github/workflows/organize.yml@refs/heads/main';
    const mode = parseDeployMode({
      AGENT_MEMORY_ORGANIZER_GITHUB_SUBJECTS: subject,
      AGENT_MEMORY_ORGANIZER_GITHUB_WORKFLOW_REFS: ` ${workflow},${workflow}, `,
    });
    assert.deepEqual(mode.organizerGithubWorkflowRefs, [workflow]);
    assert.deepEqual(parseDeployMode({ AGENT_MEMORY_ORGANIZER_GITHUB_SUBJECTS: subject }).organizerGithubWorkflowRefs, []);
    const bad = 'example-owner/example-mirror/.github/workflows/*.yml@refs/heads/main';
    assert.throws(
      () => parseDeployMode({ AGENT_MEMORY_ORGANIZER_GITHUB_SUBJECTS: subject, AGENT_MEMORY_ORGANIZER_GITHUB_WORKFLOW_REFS: bad }),
      (error: Error) => error.message.includes('AGENT_MEMORY_ORGANIZER_GITHUB_WORKFLOW_REFS') && !error.message.includes(bad),
    );
    assert.throws(
      () => parseDeployMode({ AGENT_MEMORY_ORGANIZER_GITHUB_WORKFLOW_REFS: workflow }),
      /AGENT_MEMORY_ORGANIZER_GITHUB_WORKFLOW_REFS needs AGENT_MEMORY_ORGANIZER_GITHUB_SUBJECTS/,
    );
  });

  it('reads the organizer\'s own roles and GitHub subjects, apart from the workstation ones', () => {
    const subject = 'repo:example-owner@100/example-mirror@300:ref:refs/heads/main';
    const mode = parseDeployMode({
      AGENT_MEMORY_ORGANIZER_ROLE_ARNS: ` ${ROLE_B},${ROLE_B}`,
      AGENT_MEMORY_ORGANIZER_GITHUB_SUBJECTS: `${subject}, `,
      AGENT_MEMORY_WORKSTATION_ROLE_ARNS: ROLE_A,
    });
    assert.deepEqual(mode.organizerRoleArns, [ROLE_B]);
    assert.deepEqual(mode.organizerGithubSubjects, [subject]);
    assert.deepEqual(mode.workstationRoleArns, [ROLE_A]);
    assert.deepEqual(mode.githubSubjects, []);
  });

  it('refuses a malformed workstation role or GitHub subject before anything is declared, without repeating it', () => {
    const cases: Array<[string, string]> = [
      ['AGENT_MEMORY_ORGANIZER_ROLE_ARNS', 'arn:aws:iam::123456789012:user/someone'],
      ['AGENT_MEMORY_ORGANIZER_ROLE_ARNS', '*'],
      ['AGENT_MEMORY_ORGANIZER_GITHUB_SUBJECTS', 'repo:example-owner/example-repo:pull_request'],
      ['AGENT_MEMORY_ORGANIZER_GITHUB_SUBJECTS', 'repo:example-owner/*:ref:refs/heads/main'],
      ['AGENT_MEMORY_WORKSTATION_ROLE_ARNS', 'arn:aws:iam::123456789012:user/someone'],
      ['AGENT_MEMORY_WORKSTATION_ROLE_ARNS', '*'],
      ['AGENT_MEMORY_GITHUB_SUBJECTS', 'repo:example-owner/example-repo:environment:production'],
      ['AGENT_MEMORY_GITHUB_SUBJECTS', 'repo:example-owner/*:ref:refs/heads/main'],
      ['AGENT_MEMORY_GITHUB_SUBJECTS', 'not-a-subject'],
    ];
    for (const [name, bad] of cases) {
      assert.throws(
        () => parseDeployMode({ [name]: bad }),
        (error: Error) => error.message.includes(name) && !error.message.includes(bad),
        `${name} ${bad}`,
      );
    }
  });

  describe('permissions boundary', () => {
    const BOUNDARY = 'arn:aws:iam::111122223333:policy/boundaries/agent-memory-boundary';
    const MESSAGE = 'AGENT_MEMORY_PERMISSIONS_BOUNDARY_ARN must be the ARN of an IAM managed policy.';

    it('is null when the variable is not set, empty or only blanks', () => {
      for (const env of [{}, { AGENT_MEMORY_PERMISSIONS_BOUNDARY_ARN: '' }, { AGENT_MEMORY_PERMISSIONS_BOUNDARY_ARN: ' \t ' }]) {
        assert.equal(parseDeployMode(env).permissionsBoundaryArn, null);
      }
    });

    it('reads the policy ARN, trimmed, beside the other switches', () => {
      const mode = parseDeployMode({ AGENT_MEMORY_PERMISSIONS_BOUNDARY_ARN: ` ${BOUNDARY} `, AGENT_MEMORY_INVOKER_ROLE_ARNS: ROLE_A });
      assert.deepEqual(mode, {
        direct: true,
        invokerRoleArns: [ROLE_A],
        workstationRoleArns: [],
        githubSubjects: [],
        organizerRoleArns: [],
        organizerGithubSubjects: [],
        organizerGithubWorkflowRefs: [],
        permissionsBoundaryArn: BOUNDARY,
      });
      for (const ok of ['arn:aws-cn:iam::111122223333:policy/b', 'arn:aws-us-gov:iam::111122223333:policy/b']) {
        assert.equal(parseDeployMode({ AGENT_MEMORY_PERMISSIONS_BOUNDARY_ARN: ok }).permissionsBoundaryArn, ok);
      }
    });

    it('refuses anything but a customer-managed policy ARN, with exactly one message', () => {
      for (const bad of [
        '*',
        'arn:aws:iam::aws:policy/AdministratorAccess',
        'arn:aws:iam::111122223333:role/boundary',
        'arn:aws:iam::111122223333:policy/',
        'arn:aws:iam::111122223333:policy/*',
        'arn:aws-iso:iam::111122223333:policy/boundary',
        `${BOUNDARY},${BOUNDARY}`,
      ]) {
        assert.throws(() => parseDeployMode({ AGENT_MEMORY_PERMISSIONS_BOUNDARY_ARN: bad }), { message: MESSAGE }, bad);
      }
    });
  });
});
