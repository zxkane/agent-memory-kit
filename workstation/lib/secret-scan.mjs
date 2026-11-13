// Detects credentials in note text. Reports pattern ids and line numbers only,
// never the matched text.

// The assignment name may sit inside a longer identifier (CLOUDFLARE_API_TOKEN).
// Bounded repetition keeps matching linear on very long lines.
const KEYWORDS = '(?:secret|token|password|passwd|api[_-]key|apikey|private_key)';
const NAME_TAIL = '[A-Za-z0-9_-]{0,40}';
const ASSIGNMENT_RE = new RegExp(
  `(${KEYWORDS}${NAME_TAIL})["']?\\s{0,4}[:=]\\s{0,4}["']?([A-Za-z0-9_\\-+/=.]{20,})`,
  'i',
);
// An assignment start: a keyword name, an optional quote, up to four spaces and `:` or `=`.
// Group 1 is the name. Starts are found anywhere on a line, also inside another value.
const ASSIGNMENT_START_RE = new RegExp(`(${KEYWORDS}${NAME_TAIL})["']?\\s{0,4}[:=]`, 'gi');
// What may stand between the separator and the value.
const VALUE_LEAD_RE = /\s{0,4}["']?/y;
const VALUE_CHAR_RE = /[A-Za-z0-9_\-+/=.]/;
const MIN_VALUE_LENGTH = 20;
// A variable named ...FILE, ...PATH or ...DIR that holds a location is not a secret. Both the
// name and the start of the value must say so. A value starting with `~` is not matched as an
// assignment in the first place: `~` is not a value character.
const LOCATION_NAME_RE = /(?:file|path|dir)$/i;
const LOCATION_VALUE_RE = /^(?:\/|\.\/|\.\.\/)/;
const PLACEHOLDER_WORDS = ['example', 'placeholder', 'xxxx', 'redacted'];
const PLACEHOLDER_RE = new RegExp(PLACEHOLDER_WORDS.join('|'), 'i');

// A JSON web token at one position, with no limit on any segment. Sticky: it is only tried at
// the candidate positions that hasJwt picks, so it is not a search pattern on its own.
const JWT_AT_RE = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/y;
const WORD_CHAR_RE = /[A-Za-z0-9_]/;
const TOKEN_CHAR_RE = /[A-Za-z0-9_-]/;

export const PATTERNS = Object.freeze([
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'api-key-sk', re: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
  // Also the OpenPGP form, whose header ends in "PRIVATE KEY BLOCK".
  { id: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/ },
  // Only the anchored form tried at each candidate position; scanText searches with hasJwt.
  { id: 'jwt', re: JWT_AT_RE },
  { id: 'secret-assignment', re: ASSIGNMENT_RE },
].map((p) => Object.freeze(p)));

// An access key id whose 16 characters contain one of these words is documentation or a fixture.
const FAKE_KEY_RE = /EXAMPLE|TEST|FAKE|INVALID|DUMMY/;
const AWS_KEY_RE = /\b(?:AKIA|ASIA)([0-9A-Z]{16})\b/g;

function hasAwsAccessKeyId(line) {
  for (const m of line.matchAll(AWS_KEY_RE)) {
    if (!FAKE_KEY_RE.test(m[1])) return true;
  }
  return false;
}

function isRealValue(value) {
  return value.length >= MIN_VALUE_LENGTH && /[A-Za-z]/.test(value) && /[0-9]/.test(value) &&
    !PLACEHOLDER_RE.test(value);
}

// Every assignment start on the line is judged twice: with its whole value, and with the value
// cut at the next start that begins inside it. A value that is only a location is not judged.
//
// All starts are found in one pass. Many starts can share one run of value characters, so the
// run is scanned once and records its last letter, its last digit and the start of its last
// placeholder word: a suffix of the run has a letter, a digit or a placeholder exactly when
// that position lies at or after the suffix's beginning. The cut values lie between one start's
// value and the next start, so they do not overlap and the work stays linear.
function hasSecretAssignment(line) {
  const starts = [...line.matchAll(ASSIGNMENT_START_RE)];
  let runEnd = -1;
  let lastLetter = -1;
  let lastDigit = -1;
  let lastPlaceholder = -1;
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    VALUE_LEAD_RE.lastIndex = start.index + start[0].length;
    VALUE_LEAD_RE.exec(line);
    const valueStart = VALUE_LEAD_RE.lastIndex;
    if (valueStart >= runEnd) {
      lastLetter = -1;
      lastDigit = -1;
      runEnd = valueStart;
      while (runEnd < line.length && VALUE_CHAR_RE.test(line[runEnd])) {
        const code = line.charCodeAt(runEnd);
        if (code >= 48 && code <= 57) lastDigit = runEnd;
        else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) lastLetter = runEnd;
        runEnd += 1;
      }
      const lower = line.slice(valueStart, runEnd).toLowerCase();
      lastPlaceholder = Math.max(...PLACEHOLDER_WORDS.map((word) => lower.lastIndexOf(word)));
      if (lastPlaceholder >= 0) lastPlaceholder += valueStart;
    }
    if (runEnd - valueStart < MIN_VALUE_LENGTH) continue;
    if (LOCATION_NAME_RE.test(start[1]) && LOCATION_VALUE_RE.test(line.slice(valueStart, valueStart + 3))) continue;
    if (lastLetter >= valueStart && lastDigit >= valueStart && lastPlaceholder < valueStart) return true;
    const following = starts[i + 1];
    if (following && following.index < runEnd && isRealValue(line.slice(valueStart, following.index))) return true;
  }
  return false;
}

// Tries the token at each `eyJ` not preceded by a letter, digit or `_` (a hyphen may precede
// it). When an attempt fails, every later candidate in the same run of token characters would
// fail the same way: its first segment ends where this one's does. Skipping them keeps the
// work proportional to the line length.
function hasJwt(line) {
  let from = 0;
  for (;;) {
    const at = line.indexOf('eyJ', from);
    if (at < 0) return false;
    if (at > 0 && WORD_CHAR_RE.test(line[at - 1])) {
      from = at + 1;
      continue;
    }
    JWT_AT_RE.lastIndex = at;
    if (JWT_AT_RE.test(line)) return true;
    let end = at + 3;
    while (end < line.length && TOKEN_CHAR_RE.test(line[end])) end += 1;
    from = end;
  }
}

const MATCHERS = { 'aws-access-key-id': hasAwsAccessKeyId, jwt: hasJwt, 'secret-assignment': hasSecretAssignment };

export function scanText(text) {
  const findings = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { id, re } of PATTERNS) {
      const hit = MATCHERS[id] ? MATCHERS[id](lines[i]) : re.test(lines[i]);
      if (hit) findings.push({ id, line: i + 1 });
    }
  }
  return findings;
}
