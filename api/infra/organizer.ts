/// <reference path="../.sst/platform/config.d.ts" />
import { bucket } from "./api.ts";
import { mode } from "./mode.ts";
import { jobsTrustPolicy, organizerRolePolicy, permissionsBoundaryArgs } from "./policies.ts";

// Read and checked in mode.ts, before any resource is declared.
const roleArns = mode.organizerRoleArns;
const githubSubjects = mode.organizerGithubSubjects;
const githubWorkflowRefs = mode.organizerGithubWorkflowRefs;

// The role of the job that organizes the agent scopes (`run.sh consolidate organize --agents`). It
// may change and delete agent notes, so it trusts only the principals of its own variables, not
// those of the bridge and canary roles; with workflow files, only a job defined in one of them.
// Without roles or subjects nothing here exists. It holds one inline policy and no managed policy.
if (roleArns.length > 0 || githubSubjects.length > 0) {
  const prefix = `/${$app.name}/${$app.stage}/mcp`;

  // The account's existing GitHub OIDC provider is named, never created. Without subjects the two
  // data sources are not read.
  const trustDocument =
    githubSubjects.length === 0
      ? JSON.stringify(jobsTrustPolicy({ roleArns, githubSubjects, githubWorkflowRefs }))
      : $interpolate`arn:${aws.getPartitionOutput().partition}:iam::${aws.getCallerIdentityOutput().accountId}:oidc-provider/token.actions.githubusercontent.com`.apply(
          (githubProviderArn) => JSON.stringify(jobsTrustPolicy({ roleArns, githubSubjects, githubWorkflowRefs, githubProviderArn })),
        );

  const organizerRole = new aws.iam.Role("AgentScopesOrganizerRole", {
    name: `${$app.name}-${$app.stage}-organizer`,
    maxSessionDuration: 3600,
    assumeRolePolicy: trustDocument,
    ...permissionsBoundaryArgs(mode.permissionsBoundaryArn),
  });
  new aws.iam.RolePolicy("AgentScopesOrganizerRolePolicy", {
    role: organizerRole.name,
    policy: bucket.arn.apply((arn) => JSON.stringify(organizerRolePolicy(arn))),
  });

  new aws.ssm.Parameter("ParamOrganizerRoleArn", {
    name: `${prefix}/organizer/role-arn`,
    type: "String",
    value: organizerRole.arn,
  });
}
