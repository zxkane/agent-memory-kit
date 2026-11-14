// The patterns of a bucket name and a region, in a module with no AWS code, so that the
// configuration can check them without loading the AWS client.
export const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
