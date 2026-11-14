/// <reference path="./.sst/platform/config.d.ts" />

// Deploy-time inputs come from the environment, never from this file:
//   AGENT_MEMORY_REGION                  required, the AWS region to deploy to
//   AGENT_MEMORY_WORKSTATION_ROLE_ARNS   optional, comma-separated ARNs of the workstation's IAM roles.
//                                        When set, the deployment creates a bridge role and a canary
//                                        role that those roles (and the GitHub jobs of the next variable) may
//                                        assume. Without this and the next variable, it creates neither.
//   AGENT_MEMORY_GITHUB_SUBJECTS         optional, comma-separated exact GitHub Actions subjects, for example
//                                        repo:<owner>/<repository>:ref:refs/heads/main. When set, the same two
//                                        roles also trust those jobs through the account's existing GitHub
//                                        OIDC provider, which must exist. Either variable creates the roles.
//   AGENT_MEMORY_INVOKER_ROLE_ARNS       optional, comma-separated ARNs of the IAM roles that may invoke the
//                                        function directly, for example the execution role of an AgentCore
//                                        gateway. When set, the deployment serves direct invocation only:
//                                        no HTTP API and no token issuer. Without it, the HTTP API as always.
export default $config({
  app(input) {
    const region = process.env.AGENT_MEMORY_REGION;
    if (!region) {
      throw new Error("Set AGENT_MEMORY_REGION to the AWS region to deploy to.");
    }
    const isProd = input?.stage === "prod";
    return {
      name: "agent-memory",
      home: "aws",
      removal: isProd ? "retain" : "remove",
      protect: isProd,
      providers: {
        aws: {
          region: region as aws.Region,
          defaultTags: {
            tags: {
              Project: "agent-memory",
              Stage: input?.stage ?? "",
              ManagedBy: "sst",
            },
          },
        },
      },
    };
  },
  async run() {
    // Lambda runtime is forced for every function, whatever SST defaults to.
    $transform(aws.lambda.Function, (args: aws.lambda.FunctionArgs) => {
      args.runtime = "nodejs24.x";
    });

    // Reads and checks the switches before any resource is declared.
    const { mode } = await import("./infra/mode.ts");

    await import("./infra/storage.ts");
    const { bucket, fn } = await import("./infra/api.ts");

    const outputs: Record<string, $util.Output<string>> = { bucketName: bucket.bucket };
    if (!mode.direct) {
      const http = await import("./infra/http.ts");
      outputs.apiUrl = http.api.url;
      outputs.tokenEndpoint = http.tokenEndpoint;
    }
    if (mode.direct) {
      outputs.functionArn = fn.arn;
    }

    await import("./infra/workstation.ts");

    return outputs;
  },
});
