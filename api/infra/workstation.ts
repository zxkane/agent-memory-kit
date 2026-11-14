/// <reference path="../.sst/platform/config.d.ts" />
import { bucket, parameterResources } from "./api.ts";
import { bridgeRolePolicy, canaryRolePolicy, workstationTrustPolicy } from "./policies.ts";

const roleArns = (process.env.AGENT_MEMORY_WORKSTATION_ROLE_ARNS ?? "")
  .split(",")
  .map((arn) => arn.trim())
  .filter((arn) => arn.length > 0);

// Without workstation role ARNs nothing here exists: no role, no parameter, no grant. Each role
// holds one inline policy and no managed policy; only the given workstation roles may assume it.
if (roleArns.length > 0) {
  const prefix = `/${$app.name}/${$app.stage}/mcp`;

  const bridgeRole = new aws.iam.Role("WorkstationBridgeRole", {
    name: `${$app.name}-${$app.stage}-bridge`,
    maxSessionDuration: 3600,
    assumeRolePolicy: JSON.stringify(workstationTrustPolicy(roleArns)),
  });
  new aws.iam.RolePolicy("WorkstationBridgeRolePolicy", {
    role: bridgeRole.name,
    policy: bucket.arn.apply((arn) => JSON.stringify(bridgeRolePolicy(arn))),
  });

  // The four parameters the canary's checks read, and no others (not the hub client's secret).
  const canaryParameterArns = [
    "gateway/url",
    "cognito/token-endpoint",
    "cognito/probe/client-id",
    "cognito/probe/client-secret",
  ].map((key) => parameterResources[key].arn);

  const canaryRole = new aws.iam.Role("WorkstationCanaryRole", {
    name: `${$app.name}-${$app.stage}-canary`,
    maxSessionDuration: 3600,
    assumeRolePolicy: JSON.stringify(workstationTrustPolicy(roleArns)),
  });
  new aws.iam.RolePolicy("WorkstationCanaryRolePolicy", {
    role: canaryRole.name,
    policy: $util.all(canaryParameterArns).apply((arns) => JSON.stringify(canaryRolePolicy(arns))),
  });

  new aws.ssm.Parameter("ParamBridgeRoleArn", {
    name: `${prefix}/bridge/role-arn`,
    type: "String",
    value: bridgeRole.arn,
  });
  new aws.ssm.Parameter("ParamCanaryRoleArn", {
    name: `${prefix}/canary/role-arn`,
    type: "String",
    value: canaryRole.arn,
  });
}
