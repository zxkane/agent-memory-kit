/// <reference path="./.sst/platform/config.d.ts" />

// Deploy-time inputs come from the environment, never from this file:
//   AGENT_MEMORY_REGION                  required, the AWS region to deploy to
//   AGENT_MEMORY_WORKSTATION_ROLE_ARNS   optional, comma-separated IAM role ARNs for the sync bridge
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

    await import("./infra/storage.ts");
    await import("./infra/auth.ts");
    const { api, bucket, tokenEndpoint } = await import("./infra/api.ts");

    return {
      apiUrl: api.url,
      bucketName: bucket.bucket,
      tokenEndpoint,
    };
  },
});
