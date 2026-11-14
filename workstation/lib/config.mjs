import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { BUCKET_RE, REGION_RE, ROLE_ARN_RE } from './aws-names.mjs';
import { scanText } from './secret-scan.mjs';

const HOST_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const CALENDAR_RE = /^[A-Za-z0-9 *:,./~-]{1,80}$/;
// A model ID: no whitespace or control character, not starting with "-" (it is passed as the
// value of the client's --model option), at most 300 characters. Shared with the driver's --model.
export const MODEL_RE = /^[^\s\u0000-\u001f\u007f-][^\s\u0000-\u001f\u007f]{0,299}$/;

function intIn(value, fallback, min, max) {
  const v = value === undefined ? fallback : value;
  return Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

function calendar(value) {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && CALENDAR_RE.test(value) && value.trim() !== '' ? value : undefined;
}

const CONSOLIDATE_KEYS = [
  'command', 'model', 'env', 'extract', 'organize', 'maxProjects', 'maxTranscriptBytes', 'maxTurns', 'maxBudgetUsd',
  'timeoutMinutes',
];

// Whether an unknown key may be printed by name (the driver and setup.sh echo the problem field):
// only a word-shaped key (a misspelling is a word), and not one that the secret scan flags, such
// as a letters-only access key ID. Anything else, for example a token pasted where a key should
// be, is reported only as "(an unknown key)".
const WORD_KEY_RE = /^[A-Za-z][A-Za-z_-]{0,31}$/;
function echoable(key) {
  return WORD_KEY_RE.test(key) && scanText(key).length === 0;
}

// The optional consolidation block: `{ value, problem }`. An absent block gives no value and no
// problem. A present block that is not valid gives no value (consolidation stays off; it never
// disables the rest of the config) and, as `problem`, the name of the first field that failed
// (`consolidate` when the block is not an object), so that the driver and setup can say so.
function parseConsolidate(block) {
  if (block === undefined || block === null) return { value: null, problem: null };
  const bad = (problem) => ({ value: null, problem });
  if (typeof block !== 'object' || Array.isArray(block)) return bad('consolidate');
  // A key the block does not know (a misspelt one such as `organise`) makes it invalid: ignoring
  // it would silently drop the setting it was meant to be.
  const unknown = Object.keys(block).find((key) => !CONSOLIDATE_KEYS.includes(key));
  if (unknown !== undefined) return bad(echoable(unknown) ? unknown : '(an unknown key)');
  const { command, model } = block;
  if (typeof command !== 'string' || !isAbsolute(command) || CONTROL_RE.test(command)) return bad('command');
  if (typeof model !== 'string' || !MODEL_RE.test(model)) return bad('model');
  const env = block.env ?? {};
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return bad('env');
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME_RE.test(k) || typeof v !== 'string' || CONTROL_RE.test(v)) return bad('env');
  }
  const budget = block.maxBudgetUsd ?? 5;
  const fields = {
    extract: calendar(block.extract),
    organize: calendar(block.organize),
    maxProjects: intIn(block.maxProjects, 5, 1, 50),
    maxTranscriptBytes: intIn(block.maxTranscriptBytes, 200000, 10000, 2000000),
    maxTurns: intIn(block.maxTurns, 200, 1, 1000),
    timeoutMinutes: intIn(block.timeoutMinutes, 30, 1, 240),
    maxBudgetUsd: typeof budget === 'number' && budget > 0 && budget <= 100 ? budget : undefined,
  };
  for (const [name, value] of Object.entries(fields)) if (value === undefined) return bad(name);
  const { extract, organize, maxProjects, maxTranscriptBytes, maxTurns, maxBudgetUsd, timeoutMinutes } = fields;
  return {
    value: {
      command, model, env: { ...env }, extract, organize, maxProjects, maxTranscriptBytes, maxTurns,
      maxBudgetUsd, timeoutMinutes,
    },
    problem: null,
  };
}

// Where a job takes its AWS credentials from: the instance's metadata service (default) or, inside a
// GitHub Actions job, the environment. Never both, never a fallback from one to the other.
const CREDENTIAL_SOURCES = ['instance', 'environment'];
const credentialSource = (value) => (value === undefined ? 'instance' : CREDENTIAL_SOURCES.includes(value) ? value : undefined);

const BRIDGE_KEYS = ['bucket', 'region', 'up', 'down', 'agentsRepoDir', 'agentsRepoUrl', 'roleArn', 'credentials'];

// True when one folder is the other, inside it or around it. Both get a trailing separator, so
// `/a/notes-agents` is not taken to be inside `/a/notes`.
function overlaps(a, b) {
  const x = resolve(a) + (resolve(a).endsWith(sep) ? '' : sep);
  const y = resolve(b) + (resolve(b).endsWith(sep) ? '' : sep);
  return x.startsWith(y) || y.startsWith(x);
}

// The optional bridge block, with the same contract as parseConsolidate: `{ value, problem }`.
function parseBridge(block, repoDir) {
  if (block === undefined || block === null) return { value: null, problem: null };
  const bad = (problem) => ({ value: null, problem });
  if (typeof block !== 'object' || Array.isArray(block)) return bad('bridge');
  const unknown = Object.keys(block).find((key) => !BRIDGE_KEYS.includes(key));
  if (unknown !== undefined) return bad(echoable(unknown) ? unknown : '(an unknown key)');
  if (block.up === undefined && block.down === undefined && block.agentsRepoDir === undefined) return bad('bridge');
  const up = block.up === undefined ? false : block.up;
  const down = block.down === undefined ? false : block.down;
  if (typeof up !== 'boolean') return bad('up');
  if (typeof down !== 'boolean') return bad('down');
  const needsBucket = up || down;
  const bucket = block.bucket ?? null;
  if (bucket === null ? needsBucket : typeof bucket !== 'string' || !BUCKET_RE.test(bucket)) return bad('bucket');
  const region = block.region ?? null;
  if (region === null ? needsBucket : typeof region !== 'string' || !REGION_RE.test(region)) return bad('region');
  const dir = block.agentsRepoDir ?? null;
  if (dir === null ? down : typeof dir !== 'string' || !isAbsolute(dir) || CONTROL_RE.test(dir) || overlaps(dir, repoDir)) {
    return bad('agentsRepoDir');
  }
  const url = block.agentsRepoUrl ?? null;
  // Passed to Git as an argument: no leading dash, whitespace or control character.
  if (url !== null && (typeof url !== 'string' || !MODEL_RE.test(url))) return bad('agentsRepoUrl');
  const roleArn = block.roleArn ?? null;
  if (roleArn !== null && (typeof roleArn !== 'string' || !ROLE_ARN_RE.test(roleArn))) return bad('roleArn');
  const credentials = credentialSource(block.credentials);
  if (credentials === undefined) return bad('credentials');
  return { value: { bucket, region, up, down, agentsRepoDir: dir, agentsRepoUrl: url, roleArn, credentials }, problem: null };
}

const CANARY_KEYS = ['stage', 'region', 'schedule', 'roleArn', 'credentials'];
const STAGE_RE = /^[a-z0-9-]{1,32}$/;

// The optional canary block, with the same contract as parseConsolidate: `{ value, problem }`.
function parseCanary(block) {
  if (block === undefined || block === null) return { value: null, problem: null };
  const bad = (problem) => ({ value: null, problem });
  if (typeof block !== 'object' || Array.isArray(block)) return bad('canary');
  const unknown = Object.keys(block).find((key) => !CANARY_KEYS.includes(key));
  if (unknown !== undefined) return bad(echoable(unknown) ? unknown : '(an unknown key)');
  if (typeof block.stage !== 'string' || !STAGE_RE.test(block.stage)) return bad('stage');
  if (typeof block.region !== 'string' || !REGION_RE.test(block.region)) return bad('region');
  const schedule = calendar(block.schedule);
  if (schedule === undefined) return bad('schedule');
  const roleArn = block.roleArn ?? null;
  if (roleArn !== null && (typeof roleArn !== 'string' || !ROLE_ARN_RE.test(roleArn))) return bad('roleArn');
  const credentials = credentialSource(block.credentials);
  if (credentials === undefined) return bad('credentials');
  return { value: { stage: block.stage, region: block.region, schedule, roleArn, credentials }, problem: null };
}

// The configuration file: AGENT_MEMORY_CONFIG, or ~/.config/agent-memory/config.json.
export function configPath(env = process.env) {
  return env.AGENT_MEMORY_CONFIG || join(env.HOME, '.config/agent-memory/config.json');
}

// Returns the validated config, or null when the feature is not enabled or the file is unusable.
export function loadConfig(env = process.env) {
  try {
    const home = env.HOME;
    const file = configPath(env);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object' || raw.enabled !== true) return null;
    if (typeof raw.host !== 'string' || !HOST_RE.test(raw.host)) return null;
    if (typeof raw.repoDir !== 'string' || !isAbsolute(raw.repoDir)) return null;
    const stateDir = raw.stateDir ?? join(home, '.local/state/agent-memory');
    const claudeDir = raw.claudeDir ?? join(home, '.claude');
    if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) return null;
    if (typeof claudeDir !== 'string' || !isAbsolute(claudeDir)) return null;
    const repoUrl = typeof raw.repoUrl === 'string' && raw.repoUrl ? raw.repoUrl : null;
    const stale = raw.staleAfterSeconds ?? 600;
    if (!Number.isFinite(stale) || stale <= 0) return null;
    const consolidate = parseConsolidate(raw.consolidate);
    const bridge = parseBridge(raw.bridge, raw.repoDir);
    const canary = parseCanary(raw.canary);
    return {
      host: raw.host, repoDir: raw.repoDir, repoUrl, stateDir, claudeDir, staleAfterSeconds: stale,
      consolidate: consolidate.value, consolidateProblem: consolidate.problem,
      bridge: bridge.value, bridgeProblem: bridge.problem,
      canary: canary.value, canaryProblem: canary.problem,
    };
  } catch {
    return null;
  }
}
