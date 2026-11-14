// The texts a canary record or a session warning may hold. A record is a file on disk, so every
// value that is put into a line is checked first: anything else is replaced by a fixed word.

// What the canary itself writes as an error (an AwsError message also fits CANARY_AWS_ERROR_RE).
export const CANARY_ERROR_TEXTS = ['time limit', 'checks stopped', 'canary failed'];

// The AwsError operations the canary can produce, and the message shape it accepts.
export const CANARY_OPERATIONS = ['credentials', 'ssm', 'sign'];
export const CANARY_AWS_ERROR_RE = new RegExp(`^(${CANARY_OPERATIONS.join('|')}) failed: \\d{1,3} [A-Za-z0-9]{1,40}$`);

const MAX_FAILED = 30;

// The list of failed check numbers when it is a short list of integers 0 to 99, else null.
export function failedNumbers(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FAILED) return null;
  return value.every((n) => Number.isInteger(n) && n >= 0 && n <= 99) ? value : null;
}

// Why a run failed, in words: `checks 3, 8 failed`, an allowed error text, or `failed`.
export function canaryReason({ failed, error } = {}) {
  const numbers = failedNumbers(failed);
  if (numbers !== null) return `checks ${numbers.join(', ')} failed`;
  if (typeof error === 'string' && (CANARY_ERROR_TEXTS.includes(error) || CANARY_AWS_ERROR_RE.test(error))) return error;
  return 'failed';
}
