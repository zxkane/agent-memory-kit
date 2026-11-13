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
// The start of another assignment: a keyword name followed by `:` or `=`. Group 1 is the name.
const ASSIGNMENT_START_RE = new RegExp(`(${KEYWORDS}${NAME_TAIL})["']?\\s{0,4}[:=]`, 'gi');
// Characters after a value run that can still complete an assignment start (quote, 4 spaces, separator).
const START_LOOKAHEAD = 6;
const MIN_VALUE_LENGTH = 20;
// A variable named ...FILE, ...PATH or ...DIR that holds a location is not a secret. Both the
// name and the start of the value must say so. A value starting with `~` never reaches this
// test: the value class of the assignment pattern has no `~`.
const LOCATION_NAME_RE = /(?:file|path|dir)$/i;
const LOCATION_VALUE_RE = /^(?:\/|\.\/|\.\.\/)/;
const PLACEHOLDER_RE = /example|placeholder|xxxx|redacted/i;

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

function isRealAssignment(name, value) {
  if (value.length < MIN_VALUE_LENGTH) return false;
  if (LOCATION_NAME_RE.test(name) && LOCATION_VALUE_RE.test(value)) return false;
  return /[A-Za-z]/.test(value) && /[0-9]/.test(value) && !PLACEHOLDER_RE.test(value);
}

// The greedy value run can contain the start of another assignment (`DIR=/x/TOKEN=...`), so
// each assignment is judged on its own name and value. The run is split at every embedded
// start. The pieces before the last start are judged here; the scan then resumes at the last
// start, so the ordinary pattern sees it with whatever follows the run. A character lies in at
// most two matches, because the value of the last start contains no further start.
function hasSecretAssignment(line) {
  const globalRe = new RegExp(ASSIGNMENT_RE.source, 'gi');
  let next = 0;
  for (;;) {
    globalRe.lastIndex = next;
    const m = globalRe.exec(line);
    if (!m) return false;
    const run = m[2];
    const matchEnd = m.index + m[0].length;
    const runStart = matchEnd - run.length;
    const text = run + line.slice(matchEnd, matchEnd + START_LOOKAHEAD);
    const starts = [...text.matchAll(ASSIGNMENT_START_RE)].filter((st) => st.index < run.length);
    if (starts.length === 0) {
      if (isRealAssignment(m[1], run)) return true;
      next = matchEnd;
      continue;
    }
    if (isRealAssignment(m[1], text.slice(0, starts[0].index))) return true;
    for (let i = 0; i + 1 < starts.length; i++) {
      const valueStart = starts[i].index + starts[i][0].length;
      if (isRealAssignment(starts[i][1], text.slice(valueStart, starts[i + 1].index))) return true;
    }
    next = runStart + starts[starts.length - 1].index;
  }
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
