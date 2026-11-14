/// <reference path="../.sst/platform/config.d.ts" />
import { bucketPolicy } from "./policies.ts";

const workstationRoleArns = (process.env.AGENT_MEMORY_WORKSTATION_ROLE_ARNS ?? "")
  .split(",")
  .map((arn) => arn.trim())
  .filter((arn) => arn.length > 0);

// Non-prod stages are torn down with their contents; prod is never force-emptied.
export const bucket = new aws.s3.Bucket("MemoryBucket", {
  forceDestroy: $app.stage !== "prod",
});

const publicAccess = new aws.s3.BucketPublicAccessBlock("MemoryBucketPublicAccess", {
  bucket: bucket.bucket,
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});

new aws.s3.BucketServerSideEncryptionConfiguration("MemoryBucketEncryption", {
  bucket: bucket.bucket,
  rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
});

const versioning = new aws.s3.BucketVersioning("MemoryBucketVersioning", {
  bucket: bucket.bucket,
  versioningConfiguration: { status: "Enabled" },
});

new aws.s3.BucketLifecycleConfiguration(
  "MemoryBucketLifecycle",
  {
    bucket: bucket.bucket,
    rules: [
      {
        id: "expire-old-versions-and-abandoned-uploads",
        status: "Enabled",
        filter: {},
        noncurrentVersionExpiration: { noncurrentDays: 90 },
        abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
      },
      // The two snapshots are rewritten on every write and can be megabytes each, so their old
      // versions go after one day. A noncurrent version expires as soon as any rule that matches
      // it is due, so this shorter rule wins for index/ and the 90-day rule covers the rest. The 20 most recent
      // noncurrent versions are kept whatever their age, so a corrupted snapshot can be repaired by hand.
      {
        id: "expire-index-snapshot-versions",
        status: "Enabled",
        filter: { prefix: "index/" },
        noncurrentVersionExpiration: { noncurrentDays: 1, newerNoncurrentVersions: 20 },
      },
    ],
  },
  { dependsOn: [versioning] },
);

new aws.s3.BucketPolicy(
  "MemoryBucketPolicy",
  {
    bucket: bucket.bucket,
    policy: bucket.arn.apply((arn) => JSON.stringify(bucketPolicy(arn, workstationRoleArns))),
  },
  { dependsOn: [publicAccess] },
);
