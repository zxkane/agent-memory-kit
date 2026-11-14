// The texts a bridge record or a session warning may hold, in one place. Everything else that a step
// reports is replaced by a fixed word before it is stored or shown.

export const UP_OK_STATUSES = ['unchanged', 'uploaded', 'verified', 'repaired'];
export const UP_FAILED_STATUSES = ['behind', 'raced', 'not-synced', 'diverged'];
export const DOWN_OK_STATUSES = ['unchanged', 'mirrored', 'pulled'];
export const DOWN_FAILED_STATUSES = ['push-failed'];
export const ALL_STATUS_WORDS = [...new Set([...UP_OK_STATUSES, ...UP_FAILED_STATUSES, ...DOWN_OK_STATUSES, ...DOWN_FAILED_STATUSES])];

// The texts the bridge itself writes as an error (an AwsError message also fits AWS_ERROR_RE).
export const OWN_ERROR_TEXTS = [
  'time limit', 'no time left after the sync', 'bridge up failed', 'bridge down failed',
  'credentials failed: 0 Unavailable', 'bridge could not run',
];

export const ISO_TIME_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;
// The operations an AwsError of this kit names (a test compares the list with the source). An error
// text read back from a file is accepted only with one of these, never with a pattern for "a word".
export const AWS_OPERATIONS = ['credentials', 'sign', 'ssm', 's3', 'get', 'put', 'del', 'list', 'bridge-up', 'bridge-down'];
// An AwsError message: `<operation> failed: <HTTP status> <code>`.
export const AWS_ERROR_RE = new RegExp(`^(${AWS_OPERATIONS.join('|')}) failed: \\d{1,3} [A-Za-z0-9]{1,40}$`);

// A field name of a configuration block as lib/config.mjs reports it: a plain word (its echo rule),
// or `(an unknown key)`.
export const FIELD_RE = /^(\(an unknown key\)|[A-Za-z][A-Za-z_-]{0,31})$/;

// A time may be this far ahead of now (clock differences between machines) and still be believed.
const FUTURE_MS = 5 * 60 * 1000;

// The time when it is an ISO time that is also a real date (2026-02-31 and 9999-99-99 are not), else
// null. With `now`, a time more than five minutes after it is not believed either.
export function realIsoTime(value, now) {
  if (typeof value !== 'string' || !ISO_TIME_RE.test(value)) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return now instanceof Date && at.getTime() > now.getTime() + FUTURE_MS ? null : value;
}

// The fixed texts of bridge-down.mjs (a test compares them with its source).
export const NOT_USABLE = 'the agents clone is not usable: ';
const NOT_USABLE_REASONS = [
  'the folder does not exist', 'not a Git work tree', 'not the top level of a Git work tree',
  'the notes clone cannot be resolved', 'it overlaps the notes clone', 'no .git folder', 'not on main', 'no origin',
  'the notes clone has no readable remote', 'the two clones have the same remote',
  'its remote has no .agent-memory-mirror marker', 'agents is not a folder in its remote',
  'its index does not match the mirror',
];
const BRIDGE_DOWN_STAGES = ['check', 'update', 'list', 'download', 'clean', 'commit', 'push'];
export const BRIDGE_DOWN_REASONS = [
  ...NOT_USABLE_REASONS.map((reason) => `${NOT_USABLE}${reason}`),
  'fetching the agents repository failed', 'the agents clone has a link or a file where an agent folder belongs',
  'a path left the agents clone', 'no S3 client', 'too many agent notes in the bucket',
  ...BRIDGE_DOWN_STAGES.map((stage) => `bridge down failed while trying to ${stage}`),
];
