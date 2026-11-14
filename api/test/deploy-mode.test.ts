import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// infra/mode.ts also reads process.env when it is loaded; load it with the variable unset.
delete process.env.AGENT_MEMORY_INVOKER_ROLE_ARNS;
delete process.env.AGENT_MEMORY_WORKSTATION_ROLE_ARNS;
delete process.env.AGENT_MEMORY_GITHUB_SUBJECTS;
const { parseDeployMode } = await import('../infra/mode.ts');

const ROLE_A = 'arn:aws:iam::123456789012:role/gateway-a';
const ROLE_B = 'arn:aws:iam::123456789012:role/path/gateway-b';

describe('parseDeployMode', () => {
  it('is the HTTP deployment when the variable is not set or holds only blanks', () => {
    for (const env of [{}, { AGENT_MEMORY_INVOKER_ROLE_ARNS: '' }, { AGENT_MEMORY_INVOKER_ROLE_ARNS: ' , ' }]) {
      assert.deepEqual(parseDeployMode(env), { direct: false, invokerRoleArns: [], workstationRoleArns: [], githubSubjects: [] });
    }
  });

  it('is direct invocation when roles are given, trimmed, without empty entries or duplicates', () => {
    const mode = parseDeployMode({ AGENT_MEMORY_INVOKER_ROLE_ARNS: ` ${ROLE_A}, ,${ROLE_B},${ROLE_A}` });
    assert.deepEqual(mode, { direct: true, invokerRoleArns: [ROLE_A, ROLE_B], workstationRoleArns: [], githubSubjects: [] });
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

  it('refuses a malformed workstation role or GitHub subject before anything is declared, without repeating it', () => {
    const cases: Array<[string, string]> = [
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
});
