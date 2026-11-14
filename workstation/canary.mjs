// The canary: runs the deployed checks of api/scripts/verify-deployed.ts against the stage named in
// the `canary` block and records the result in <stateDir>/canary.json. Started through
// `run.sh canary`, by hand or by the timer that setup.sh writes.
//
// What it never keeps or prints: the probe secret, a token, a URL or any value read from Parameter
// Store, a response body. The secret and the tokens live in memory for one run. The record holds a
// time, the numbers of the failed checks and one of a few fixed error texts.
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChecksStoppedError, formatResult, makeMintToken, runChecks } from '../api/scripts/verify-deployed.ts';
import { AwsError, assumeRole, environmentCredentials, imdsCredentials, ssmGetParameter } from './lib/aws.mjs';
import { FIELD_RE, realIsoTime } from './lib/bridge-text.mjs';
import { CANARY_AWS_ERROR_RE, canaryReason } from './lib/canary-text.mjs';
import { loadConfig } from './lib/config.mjs';

const DEFAULT_LIMIT_MS = 240_000;
const LIMIT = Symbol('time limit');
// A JSON web token: three base64url parts, the first starting with the encoding of `{"`.
const TOKEN_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

const PARAMETERS = ['gateway/url', 'cognito/token-endpoint', 'cognito/probe/client-id', 'cognito/probe/client-secret'];

// The error text of a run that stopped: only the fixed words, or an AwsError of a known shape.
function errorText(err) {
  if (err instanceof AwsError && CANARY_AWS_ERROR_RE.test(err.message)) return err.message;
  if (err instanceof ChecksStoppedError || err?.name === 'ChecksStoppedError') return 'checks stopped';
  return 'canary failed';
}

// The number of a check: the integer its name starts with (`5a. ...` is 5); 0 when there is none.
function checkNumber(name) {
  const m = /^(\d{1,2})(?!\d)/.exec(typeof name === 'string' ? name : '');
  return m === null ? 0 : Number(m[1]);
}

function lastSuccessBefore(file, now) {
  try {
    return realIsoTime(JSON.parse(readFileSync(file, 'utf8'))?.lastSuccess, now) ?? null;
  } catch {
    return null;
  }
}

// Writes the record through a temporary file and a rename, mode 0600.
function writeRecord(stateDir, record) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, 'canary.json');
  const tmp = `${file}.tmp.${process.pid}`;
  rmSync(tmp, { force: true });
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// One run. `config` is a loaded config with a valid `canary` block. deps (tests): credentials (a
// function or the credentials), environmentCredentials, assumeRole, fetchImpl, runChecks, makeMintToken, stdout (a function taking text).
// One deadline of `limitMs` covers everything, parameter requests included.
export async function runCanary({ config, deps = {}, now = new Date(), limitMs = DEFAULT_LIMIT_MS }) {
  const { stage, region, roleArn, credentials: source } = config.canary;
  const stateFile = join(config.stateDir, 'canary.json');
  const out = deps.stdout ?? ((text) => process.stdout.write(text));

  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => controller.abort(), limitMs);
  const expired = new Promise((resolve) => signal.addEventListener('abort', () => resolve(LIMIT), { once: true }));
  const baseFetch = deps.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  // Every request, the checks' own included, also ends at the deadline.
  const fetchImpl = (input, init = {}) => baseFetch(input, {
    ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal,
  });

  // Values that must never be printed: what was read from Parameter Store and every token. A line
  // is also reduced to one line of printable text, and anything shaped like a token is removed.
  const hidden = new Set();
  let closed = false; // set when the run is over: a result that arrives later is not printed
  const printable = (line) => {
    let text = String(line).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(TOKEN_RE, '[redacted]');
    for (const value of hidden) text = text.split(value).join('[redacted]');
    return text;
  };
  const print = (line) => {
    if (!closed) out(`${printable(line)}\n`);
  };

  let results = null;
  let error = null;
  try {
    const work = (async () => {
      // One source, chosen by the block: the environment of a GitHub Actions job or the metadata
      // service. Neither is a fallback for the other.
      const instance = source === 'environment'
        ? (deps.environmentCredentials ?? environmentCredentials)()
        : typeof deps.credentials === 'function'
          ? await deps.credentials()
          : (deps.credentials ?? await imdsCredentials({ fetchImpl }));
      // With a dedicated role these credentials only sign the exchange; Parameter Store gets the role's.
      const credentials = roleArn
        ? await (deps.assumeRole ?? assumeRole)({
          roleArn, sessionName: 'agent-memory-canary', region, credentials: instance, fetchImpl,
        })
        : instance;
      const values = [];
      for (const key of PARAMETERS) {
        const value = await ssmGetParameter({ name: `/agent-memory/${stage}/mcp/${key}`, region, credentials, fetchImpl });
        if (value !== '') hidden.add(value);
        values.push(value);
      }
      const [apiUrl, tokenEndpoint, clientId, clientSecret] = values;
      const mint = (deps.makeMintToken ?? makeMintToken)({ fetch: fetchImpl, tokenEndpoint, clientId, clientSecret });
      const mintToken = async (scopes) => {
        const token = await mint(scopes);
        if (typeof token === 'string' && token !== '') hidden.add(token);
        return token;
      };
      return (deps.runChecks ?? runChecks)({
        fetch: fetchImpl,
        config: { apiUrl, tokenEndpoint },
        mintToken,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        expired: false,
        stage,
        onResult: (result) => print(formatResult(result)),
      });
    })();
    work.catch(() => {}); // a run left behind at the deadline that fails later is not an unhandled rejection
    const winner = await Promise.race([work, expired]);
    if (winner === LIMIT) error = 'time limit';
    else results = winner;
  } catch (err) {
    error = signal.aborted ? 'time limit' : errorText(err);
  } finally {
    clearTimeout(timer);
    closed = true;
    controller.abort(); // whatever a run left behind stops here
  }

  const list = Array.isArray(results) ? results : [];
  if (error === null && list.length === 0) error = 'canary failed';
  const failed = [...new Set(list.filter((r) => r?.ok !== true).map((r) => checkNumber(r?.name)))];
  const ok = error === null && failed.length === 0;
  const lastRun = now.toISOString();
  writeRecord(config.stateDir, {
    lastRun, ok, failed, error, lastSuccess: ok ? lastRun : lastSuccessBefore(stateFile, now),
  });
  out(`${printable(ok ? `canary ok: ${list.length} checks` : `canary failed: ${canaryReason({ failed, error })}`)}\n`);
  return { ok, failed, error };
}

// ---- the program ----

async function main() {
  const config = loadConfig();
  if (!config) return 0;
  if (config.canaryProblem !== null) {
    const field = FIELD_RE.test(config.canaryProblem) ? config.canaryProblem : 'unknown';
    process.stdout.write(`agent-memory canary: the canary block in the configuration is invalid (${field}); the canary is off.\n`);
    return 1;
  }
  if (config.canary === null) return 0;
  try {
    return (await runCanary({ config })).ok ? 0 : 1;
  } catch {
    process.stderr.write('agent-memory canary could not record its result\n');
    return 1;
  }
}

const isMain = process.argv[1] !== undefined && (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exitCode = await main();
  // A request left behind at the time limit must not keep the process alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
}
