/// <reference path="../.sst/platform/config.d.ts" />
import { RESOURCE_SERVER, ROUTES } from "../src/routes.ts";
import { fn, publishParameter } from "./api.ts";
import { hubClient, issuer, probeClient, tokenEndpoint } from "./auth.ts";

export { tokenEndpoint };

// The HTTP API with its token issuer. sst.config.ts loads this file only when AGENT_MEMORY_HTTP_API
// is not "off"; the function itself is declared in api.ts.

// No query string and no headers. The client ID comes from the validated token.
const accessLogFormat = JSON.stringify({
  requestId: "$context.requestId",
  requestTime: "$context.requestTime",
  sourceIp: "$context.identity.sourceIp",
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

const parameters: { key: string; type: "String" | "SecureString"; value: $util.Input<string> }[] = [
  { key: "gateway/url", type: "String", value: api.url },
  { key: "cognito/issuer", type: "String", value: issuer },
  { key: "cognito/token-endpoint", type: "String", value: tokenEndpoint },
  { key: "cognito/hub/client-id", type: "String", value: hubClient.id },
  { key: "cognito/hub/client-secret", type: "SecureString", value: hubClient.clientSecret },
  { key: "cognito/hub/credential-version", type: "String", value: "1" },
  { key: "cognito/probe/client-id", type: "String", value: probeClient.id },
  { key: "cognito/probe/client-secret", type: "SecureString", value: probeClient.clientSecret },
];

for (const parameter of parameters) {
  publishParameter(parameter.key, parameter.type, parameter.value);
}
