// The two switches of a deployment, read and checked in one place. sst.config.ts loads this file
// before any resource is declared, so a bad value stops the deployment before anything exists.
//   AGENT_MEMORY_HTTP_API            absent or "on": the HTTP API and the token issuer, as always.
//                                    "off": neither; the function is reachable only by direct invocation.
//   AGENT_MEMORY_INVOKER_ROLE_ARNS   optional, comma-separated ARNs of the IAM roles that may invoke the
//                                    function directly (the execution role of an AgentCore gateway).
//                                    Required when the HTTP API is off.
import { isRoleArn } from "./policies.ts";

export type DeployMode = {
  httpApi: boolean;
  invokerRoleArns: string[];
};

export function parseDeployMode(env: Record<string, string | undefined>): DeployMode {
  const httpApiValue = env.AGENT_MEMORY_HTTP_API;
  if (httpApiValue !== undefined && httpApiValue !== "on" && httpApiValue !== "off") {
    throw new Error('AGENT_MEMORY_HTTP_API must be "on" or "off", or not set.');
  }
  const httpApi = httpApiValue !== "off";

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

  if (!httpApi && invokerRoleArns.length === 0) {
    throw new Error(
      "AGENT_MEMORY_HTTP_API=off leaves the function with no way in: also set AGENT_MEMORY_INVOKER_ROLE_ARNS to the roles that may invoke it.",
    );
  }
  return { httpApi, invokerRoleArns };
}

export const mode = parseDeployMode(process.env);
