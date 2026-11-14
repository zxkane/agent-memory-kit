import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// infra/mode.ts also reads process.env when it is loaded; load it with both variables unset.
delete process.env.AGENT_MEMORY_HTTP_API;
delete process.env.AGENT_MEMORY_INVOKER_ROLE_ARNS;
const { parseDeployMode } = await import('../infra/mode.ts');

const ROLE_A = 'arn:aws:iam::123456789012:role/gateway-a';
const ROLE_B = 'arn:aws:iam::123456789012:role/path/gateway-b';

describe('parseDeployMode', () => {
  it('is the HTTP API without invoker roles when nothing is set', () => {
    assert.deepEqual(parseDeployMode({}), { httpApi: true, invokerRoleArns: [] });
  });

  it('treats on as the default', () => {
    assert.deepEqual(parseDeployMode({ AGENT_MEMORY_HTTP_API: 'on' }), { httpApi: true, invokerRoleArns: [] });
  });

  it('reads a list of invoker roles, trimmed, without empty entries or duplicates', () => {
    const mode = parseDeployMode({ AGENT_MEMORY_INVOKER_ROLE_ARNS: ` ${ROLE_A}, ,${ROLE_B},${ROLE_A}` });
    assert.deepEqual(mode, { httpApi: true, invokerRoleArns: [ROLE_A, ROLE_B] });
  });

  it('allows off with invoker roles', () => {
    const mode = parseDeployMode({ AGENT_MEMORY_HTTP_API: 'off', AGENT_MEMORY_INVOKER_ROLE_ARNS: ROLE_A });
    assert.deepEqual(mode, { httpApi: false, invokerRoleArns: [ROLE_A] });
  });

  it('refuses off without invoker roles and names both variables', () => {
    for (const env of [
      { AGENT_MEMORY_HTTP_API: 'off' },
      { AGENT_MEMORY_HTTP_API: 'off', AGENT_MEMORY_INVOKER_ROLE_ARNS: ' , ' },
    ]) {
      assert.throws(
        () => parseDeployMode(env),
        (error: Error) => /AGENT_MEMORY_HTTP_API/.test(error.message) && /AGENT_MEMORY_INVOKER_ROLE_ARNS/.test(error.message),
      );
    }
  });

  it('refuses any other value of the HTTP API variable', () => {
    for (const value of ['', 'OFF', 'On', 'false', 'no', '0', 'off ']) {
      assert.throws(
        () => parseDeployMode({ AGENT_MEMORY_HTTP_API: value, AGENT_MEMORY_INVOKER_ROLE_ARNS: ROLE_A }),
        /AGENT_MEMORY_HTTP_API/,
        JSON.stringify(value),
      );
    }
  });

  it('refuses anything that is not an IAM role ARN', () => {
    for (const bad of [
      '*',
      'lambda.amazonaws.com',
      'arn:aws:iam::123456789012:root',
      'arn:aws:iam::123456789012:user/someone',
      'arn:aws:iam::123456789012:role/*',
      'arn:aws:iam::*:role/gateway',
      `${ROLE_A},arn:aws:iam::123456789012:role/`,
    ]) {
      assert.throws(() => parseDeployMode({ AGENT_MEMORY_INVOKER_ROLE_ARNS: bad }), /AGENT_MEMORY_INVOKER_ROLE_ARNS/, bad);
    }
  });
});
