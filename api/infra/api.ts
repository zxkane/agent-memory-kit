/// <reference path="../.sst/platform/config.d.ts" />
import { bucket } from "./storage.ts";
import { mode } from "./mode.ts";
import { functionPolicy, logsPolicy, trustPolicy } from "./policies.ts";

export { bucket };

// The function's role holds exactly two inline policies, functionPolicy(bucketArn)
// and logsPolicy(logGroupArn), and no managed policy. The log group is created
// here so SST does not attach the broad basic-execution managed policy.
const logGroup = new aws.cloudwatch.LogGroup("MemoryApiLogGroup", {
  name: `/aws/lambda/${$app.name}-${$app.stage}-api`,
  retentionInDays: 30,
});

export const fn = new sst.aws.Function("MemoryApiFunction", {
  handler: "src/handler.handler",
  architecture: "arm64",
  memory: "256 MB",
  timeout: "10 seconds",
  environment: { BUCKET: bucket.bucket, ...(mode.invokerRoleArns.length > 0 ? { DIRECT_INVOCATION: "on" } : {}) },
  logging: { logGroup: logGroup.name },
  dev: false,
  transform: {
    role: (args: aws.iam.RoleArgs) => {
      // Set explicitly: the component would otherwise also trust the whole account.
      args.assumeRolePolicy = JSON.stringify(trustPolicy());
      args.managedPolicyArns = [];
      args.inlinePolicies = $util.all([bucket.arn, logGroup.arn]).apply(([bucketArn, logGroupArn]) => [
        { name: "bucket-access", policy: JSON.stringify(functionPolicy(bucketArn)) },
        { name: "logs", policy: JSON.stringify(logsPolicy(logGroupArn)) },
      ]);
    },
  },
});

const prefix = `/${$app.name}/${$app.stage}/mcp`;

// The parameter resources by key, so that infra/workstation.ts can name their ARNs.
export const parameterResources: Record<string, aws.ssm.Parameter> = {};

export function publishParameter(key: string, type: "String" | "SecureString", value: $util.Input<string>) {
  parameterResources[key] = new aws.ssm.Parameter(`Param${key.replace(/[^A-Za-z0-9]+/g, "-")}`, {
    name: `${prefix}/${key}`,
    type,
    value,
  });
}

publishParameter("bucket/name", "String", bucket.bucket);

// Direct invocation: each named role may invoke the function, and nobody else gets a permission.
// The logical name carries the position, not the ARN, so that the ARN text is not an identity.
if (mode.invokerRoleArns.length > 0) {
  mode.invokerRoleArns.forEach((roleArn, index) => {
    new aws.lambda.Permission(`MemoryApiInvoker${index}`, {
      action: "lambda:InvokeFunction",
      function: fn.name,
      principal: roleArn,
    });
  });
  publishParameter("function/arn", "String", fn.arn);
}
