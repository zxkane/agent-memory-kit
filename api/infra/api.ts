/// <reference path="../.sst/platform/config.d.ts" />
import { RESOURCE_SERVER, ROUTES } from "../src/routes.ts";
import { bucket } from "./storage.ts";
import { hubClient, issuer, probeClient, tokenEndpoint } from "./auth.ts";
import { functionPolicy } from "./policies.ts";

export { bucket, tokenEndpoint };

// The function's permissions are exactly functionPolicy(bucketArn): no link,
// no Function URL, nothing else on the bucket.
const permissions = bucket.arn.apply((arn) =>
  functionPolicy(arn).Statement.map((statement) => ({
    effect: statement.Effect === "Allow" ? ("allow" as const) : ("deny" as const),
    actions: statement.Action,
    resources: statement.Resource,
  })),
);

const fn = new sst.aws.Function("MemoryApiFunction", {
  handler: "src/handler.handler",
  architecture: "arm64",
  memory: "256 MB",
  timeout: "10 seconds",
  environment: { BUCKET: bucket.bucket },
  permissions,
  logging: { retention: "1 month" },
  dev: false,
});

// No query string and no headers. The client ID comes from the validated token.
const accessLogFormat = JSON.stringify({
  requestId: "$context.requestId",
  requestTime: "$context.requestTime",
  routeKey: "$context.routeKey",
  status: "$context.status",
  responseLength: "$context.responseLength",
  integrationErrorMessage: "$context.integrationErrorMessage",
  authorizerError: "$context.authorizer.error",
  clientId: "$context.authorizer.claims.client_id",
});

export const api = new sst.aws.ApiGatewayV2("MemoryApi", {
  cors: false,
  accessLog: { retention: "1 month" },
  transform: {
    stage: (args: aws.apigatewayv2.StageArgs) => {
      args.defaultRouteSettings = {
        throttlingBurstLimit: 10,
        throttlingRateLimit: 5,
      };
      args.accessLogSettings = $output(args.accessLogSettings).apply((settings) => ({
        ...settings!,
        format: accessLogFormat,
      }));
    },
  },
});

const authorizer = api.addAuthorizer({
  name: "Cognito",
  jwt: {
    issuer,
    audiences: [hubClient.id, probeClient.id],
  },
});

// One route per entry of ROUTES, each with the authorizer and its scope.
for (const route of ROUTES) {
  api.route(`${route.method} ${route.path}`, fn, {
    auth: {
      jwt: {
        authorizer: authorizer.id,
        scopes: [`${RESOURCE_SERVER}/${route.scope}`],
      },
    },
  });
}

const prefix = `/${$app.name}/${$app.stage}/mcp`;

const parameters: { key: string; type: "String" | "SecureString"; value: $util.Input<string> }[] = [
  { key: "gateway/url", type: "String", value: api.url },
  { key: "cognito/issuer", type: "String", value: issuer },
  { key: "cognito/token-endpoint", type: "String", value: tokenEndpoint },
  { key: "cognito/hub/client-id", type: "String", value: hubClient.id },
  { key: "cognito/hub/client-secret", type: "SecureString", value: hubClient.clientSecret },
  { key: "cognito/hub/credential-version", type: "String", value: "1" },
  { key: "cognito/probe/client-id", type: "String", value: probeClient.id },
  { key: "cognito/probe/client-secret", type: "SecureString", value: probeClient.clientSecret },
  { key: "bucket/name", type: "String", value: bucket.bucket },
];

for (const parameter of parameters) {
  new aws.ssm.Parameter(`Param${parameter.key.replace(/[^A-Za-z0-9]+/g, "-")}`, {
    name: `${prefix}/${parameter.key}`,
    type: parameter.type,
    value: parameter.value,
  });
}
