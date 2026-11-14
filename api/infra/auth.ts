/// <reference path="../.sst/platform/config.d.ts" />
import { RESOURCE_SERVER } from "../src/routes.ts";

const region = aws.getRegionOutput().region;

// Only machine clients use this pool. No self sign-up and no users are created.
// A replaced pool loses its clients and revokes tokens, so only non-prod stages
// may delete before replacing.
export const userPool = new aws.cognito.UserPool(
  "MemoryUserPool",
  {
    adminCreateUserConfig: { allowAdminCreateUserOnly: true },
  },
  $app.stage === "prod" ? {} : { deleteBeforeReplace: true },
);

// The domain prefix is the pool ID, lower-cased, with the underscore replaced.
export const userPoolDomain = new aws.cognito.UserPoolDomain("MemoryUserPoolDomain", {
  userPoolId: userPool.id,
  domain: userPool.id.apply((id) => id.toLowerCase().replace("_", "-")),
});

const resourceServer = new aws.cognito.ResourceServer("MemoryResourceServer", {
  userPoolId: userPool.id,
  identifier: RESOURCE_SERVER,
  name: RESOURCE_SERVER,
  scopes: [
    { scopeName: "read", scopeDescription: "Read memory notes" },
    { scopeName: "write", scopeDescription: "Write notes into agent scopes" },
  ],
});

const clientBase = {
  userPoolId: userPool.id,
  generateSecret: true,
  allowedOauthFlows: ["client_credentials"],
  allowedOauthFlowsUserPoolClient: true,
  allowedOauthScopes: resourceServer.scopeIdentifiers,
  enableTokenRevocation: true,
};

export const hubClient = new aws.cognito.UserPoolClient("MemoryHubClient", {
  ...clientBase,
  name: "hub",
  accessTokenValidity: 1,
  tokenValidityUnits: { accessToken: "days" },
});

// Used only by the deployed checks.
export const probeClient = new aws.cognito.UserPoolClient("MemoryProbeClient", {
  ...clientBase,
  name: "probe",
  accessTokenValidity: 5,
  tokenValidityUnits: { accessToken: "minutes" },
});

export const issuer = $interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`;

export const tokenEndpoint = $interpolate`https://${userPoolDomain.domain}.auth.${region}.amazoncognito.com/oauth2/token`;
