// The one switch of a deployment, read and checked in one place. sst.config.ts loads this file
// before any resource is declared, so a bad value stops the deployment before anything exists.
//   AGENT_MEMORY_INVOKER_ROLE_ARNS   optional, comma-separated ARNs of the IAM roles that may invoke the
//                                    function directly (the execution role of an AgentCore gateway).
//                                    Not set: the HTTP API with its own token issuer. Set: direct
//                                    invocation only, with neither of those. A deployment serves one
//                                    kind of invocation, never both.
//   AGENT_MEMORY_WORKSTATION_ROLE_ARNS  optional, comma-separated ARNs of IAM roles that may assume the
//                                    bridge and canary roles.
//   AGENT_MEMORY_GITHUB_SUBJECTS     optional, comma-separated GitHub Actions subjects that may do the same.
import { isGithubSubject, isRoleArn } from "./policies.ts";

export type DeployMode = {
  /** True when roles are given: direct invocation only. */
  direct: boolean;
  invokerRoleArns: string[];
  workstationRoleArns: string[];
  githubSubjects: string[];
};

// A comma-separated list: trimmed, without empty entries or duplicates.
function list(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

export function parseDeployMode(env: Record<string, string | undefined>): DeployMode {
  const invokerRoleArns = list(env.AGENT_MEMORY_INVOKER_ROLE_ARNS);
  const workstationRoleArns = list(env.AGENT_MEMORY_WORKSTATION_ROLE_ARNS);
  const githubSubjects = list(env.AGENT_MEMORY_GITHUB_SUBJECTS);
  for (const arn of invokerRoleArns) {
    if (!isRoleArn(arn)) {
      throw new Error("Each entry of AGENT_MEMORY_INVOKER_ROLE_ARNS must be the ARN of an IAM role.");
    }
  }
  for (const arn of workstationRoleArns) {
    if (!isRoleArn(arn)) {
      throw new Error("Each entry of AGENT_MEMORY_WORKSTATION_ROLE_ARNS must be the ARN of an IAM role.");
    }
  }
  for (const subject of githubSubjects) {
    if (!isGithubSubject(subject)) {
      throw new Error("Each entry of AGENT_MEMORY_GITHUB_SUBJECTS must be repo:<owner>/<repository>:ref:refs/heads/<branch> or repo:<owner>@<owner-id>/<repository>@<repository-id>:ref:refs/heads/<branch>.");
    }
  }
  return { direct: invokerRoleArns.length > 0, invokerRoleArns, workstationRoleArns, githubSubjects };
}

export const mode = parseDeployMode(process.env);
