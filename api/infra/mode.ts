// The one switch of a deployment, read and checked in one place. sst.config.ts loads this file
// before any resource is declared, so a bad value stops the deployment before anything exists.
//   AGENT_MEMORY_INVOKER_ROLE_ARNS   optional, comma-separated ARNs of the IAM roles that may invoke the
//                                    function directly (the execution role of an AgentCore gateway).
//                                    Not set: the HTTP API with its own token issuer. Set: direct
//                                    invocation only, with neither of those. A deployment serves one
//                                    kind of invocation, never both.
import { isRoleArn } from "./policies.ts";

export type DeployMode = {
  /** True when roles are given: direct invocation only. */
  direct: boolean;
  invokerRoleArns: string[];
};

export function parseDeployMode(env: Record<string, string | undefined>): DeployMode {
  const invokerRoleArns = [
    ...new Set(
      (env.AGENT_MEMORY_INVOKER_ROLE_ARNS ?? "")
        .split(",")
        .map((arn) => arn.trim())
        .filter((arn) => arn.length > 0),
    ),
  ];
  for (const arn of invokerRoleArns) {
    if (!isRoleArn(arn)) {
      throw new Error("Each entry of AGENT_MEMORY_INVOKER_ROLE_ARNS must be the ARN of an IAM role.");
    }
  }
  return { direct: invokerRoleArns.length > 0, invokerRoleArns };
}

export const mode = parseDeployMode(process.env);
