/// <reference path="../.sst/platform/config.d.ts" />
import { bucketPolicy } from "./policies.ts";

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

// Not versioned. The notes under mem/ are a copy of the notes repository and can be uploaded again.
// The agents' notes are copied into a second repository only when the bridge's down step runs, and
// only what a run has copied, so a replaced agent note may have no other copy. A bucket that an
// earlier release versioned keeps its versioning in the suspended state (S3 cannot turn it off
// again); this rule then removes the old versions after one day, and the delete markers they left.
new aws.s3.BucketLifecycleConfiguration("MemoryBucketLifecycle", {
  bucket: bucket.bucket,
  rules: [
    {
      id: "expire-abandoned-uploads-and-old-versions",
      status: "Enabled",
      filter: {},
      abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
      noncurrentVersionExpiration: { noncurrentDays: 1 },
      expiration: { expiredObjectDeleteMarker: true },
    },
  ],
});

new aws.s3.BucketPolicy(
  "MemoryBucketPolicy",
  {
    bucket: bucket.bucket,
    policy: bucket.arn.apply((arn) => JSON.stringify(bucketPolicy(arn))),
  },
  { dependsOn: [publicAccess] },
);
