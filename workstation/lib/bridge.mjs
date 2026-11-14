// Runs the two bridge steps after a successful sync and reduces each outcome to a small record for
// status.json. A record holds a status word from a fixed list, an error that is fixed text or an
// AwsError-shaped message, a time and counts: never a path, a key, a URL or any text that came from
// the bucket, a remote or a note. A failing step never makes the sync fail; the caller decides the
// exit code from the sync.

import { AwsError, assumeRole, environmentCredentials, imdsCredentials } from './aws.mjs';
import { BridgeDownError, runBridgeDown } from './bridge-down.mjs';
import {
  ALL_STATUS_WORDS, AWS_ERROR_RE, BRIDGE_DOWN_REASONS, DOWN_FAILED_STATUSES, DOWN_OK_STATUSES, OWN_ERROR_TEXTS,
  UP_FAILED_STATUSES, UP_OK_STATUSES,
} from './bridge-text.mjs';
import { runBridgeUp } from './bridge-up.mjs';
import { createS3 } from './s3.mjs';

const MAX_ERROR_CHARS = 200;
const COMMIT_RE = /^[0-9a-f]{40}$/;

// The unit gives a run 120 s (TimeoutStartSec). One deadline covers the bridge (the sync has its own limits): 110 s
// after the process started, and at most 75 s after the bridge began when it runs after a sync
// (`run.sh bridge` passes its own, longer limit and has no process deadline). Everything that can block for
// long is cut at it: S3 requests (the client's signal is aborted then) and the Git network commands
// of both steps (each gets min(its own limit, time left) and is not started with less than 2 s left).
// What can still run after the deadline is local work (Git on a local clone, writing status.json),
// which leaves 10 s of the 120 s for it and for the start of the process. A step is not started at
// or after the deadline. With less than MIN_BRIDGE_MS left the bridge is not started at all.
const DEADLINE_MS = 110_000;
const BRIDGE_MAX_MS = 75_000;
const MIN_BRIDGE_MS = 5_000;

export const bridgeLimitMs = (elapsedMs) => Math.min(BRIDGE_MAX_MS, DEADLINE_MS - elapsedMs);

const LIMIT = Symbol('time limit');
const oneLine = (text) => String(text).split(/\r?\n/)[0].slice(0, MAX_ERROR_CHARS);

const ERROR_TEXTS = new Set([...ALL_STATUS_WORDS, ...OWN_ERROR_TEXTS, ...BRIDGE_DOWN_REASONS]);
const safeError = (text, fallback) => (typeof text === 'string' && (ERROR_TEXTS.has(text) || AWS_ERROR_RE.test(text)) ? text : fallback);

// What a thrown error may put in a record: the message of an AwsError or of bridge down's own error
// class when it is one of the known shapes and fixed texts; otherwise the fallback.
function errorText(err, fallback) {
  if (err instanceof AwsError || err instanceof BridgeDownError) return safeError(oneLine(err.message), fallback);
  return fallback;
}

const count = (list, reason) => (Array.isArray(list) ? list.filter((s) => s?.reason === reason).length : 0);
const num = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const commitOf = (result) => (COMMIT_RE.test(result?.commit ?? '') ? { commit: result.commit } : {});

// `{ ok, status, error }` from a result: its status when it is one of the known words of the step,
// otherwise a failure with no status and the step's fixed text.
function stepStatus(result, okWords, failedWords, fallback) {
  const status = typeof result?.status === 'string' ? result.status : null;
  if (status !== null && okWords.includes(status)) return { ok: true, status, error: null };
  if (status !== null && failedWords.includes(status)) return { ok: false, status, error: status };
  return { ok: false, status: null, error: fallback };
}

function upRecord(result, at) {
  return {
    ...stepStatus(result, UP_OK_STATUSES, UP_FAILED_STATUSES, 'bridge up failed'), at, ...commitOf(result),
    full: result?.full === true, puts: num(result?.puts), deletes: num(result?.deletes), foreign: num(result?.foreign),
    snapshotBytes: num(result?.snapshotBytes), bodyLimit: num(result?.bodyLimit),
    skipped: { flagged: count(result?.skipped, 'flagged'), 'too-large': count(result?.skipped, 'too-large') },
  };
}

function downRecord(result, at) {
  return {
    ...stepStatus(result, DOWN_OK_STATUSES, DOWN_FAILED_STATUSES, 'bridge down failed'), at, ...commitOf(result),
    written: num(result?.written), removed: num(result?.removed),
    skipped: {
      'bad-key': count(result?.skipped, 'bad-key'), 'too-large': count(result?.skipped, 'too-large'), flagged: count(result?.skipped, 'flagged'),
    },
    ...(result?.skippedMore > 0 ? { skippedMore: num(result.skippedMore) } : {}),
  };
}

const failure = (error, at) => ({ ok: false, status: null, error, at });

// Which steps a bridge block asks for. Pull-only (`down` false with a folder) needs no S3.
export function configuredSteps(bridge) {
  return {
    up: bridge?.up === true,
    down: typeof bridge?.agentsRepoDir === 'string' && bridge.agentsRepoDir !== '',
    needsS3: bridge?.up === true || bridge?.down === true,
  };
}

// `{ up, down }`: a step record, or null when the step is not configured. Null when there is no
// bridge block or the sync failed (nothing is attempted after a failed sync).
// `processStart`: epoch milliseconds when the run began (the deadline is 110 s after it); `limitMs`:
// the most the bridge itself may take (the default is 75 s; a caller may give more, as `run.sh bridge` does); `clock`: the time source (tests).
// deps (tests): credentials (the metadata source), environmentCredentials, assumeRole, fetchImpl, createS3, runBridgeUp, runBridgeDown.
export async function runBridge({
  config, syncResult, deps = {}, now = new Date(), limitMs = BRIDGE_MAX_MS, processStart, clock = Date.now,
}) {
  const bridge = config?.bridge ?? null;
  if (bridge === null || syncResult?.ok !== true) return null;
  const at = now.toISOString();
  const want = configuredSteps(bridge);
  const result = { up: null, down: null };

  const deadline = Math.min(clock() + limitMs, processStart === undefined ? Infinity : processStart + DEADLINE_MS);
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - clock()));
  const expired = new Promise((resolve) => {
    if (signal.aborted) resolve(LIMIT);
    else signal.addEventListener('abort', () => resolve(LIMIT), { once: true });
  });
  // The clock is checked as well as the signal: a step that blocked the event loop returns before
  // the timer has had a chance to fire.
  const late = () => signal.aborted || clock() >= deadline;
  // Runs `fn` against the limit: a step that does not settle in time is left behind (its signal
  // is aborted) and the run goes on.
  const within = async (fn) => {
    if (late()) throw LIMIT;
    const work = Promise.resolve().then(fn);
    work.catch(() => {}); // an abandoned step that fails later is not an unhandled rejection
    const winner = await Promise.race([work, expired]);
    if (winner === LIMIT) throw LIMIT;
    return winner;
  };
  const timeLimit = (err) => err === LIMIT || (late() && err instanceof AwsError && err.code === 'TimeLimit');
  const stepDeadline = Number.isFinite(deadline) ? deadline : undefined;

  try {
    let s3 = null;
    let s3Error = null;
    if (want.needsS3 && !late()) {
      try {
        s3 = await within(async () => {
          // One source, chosen by the block: the environment of a GitHub Actions job or the metadata
          // service. Neither is a fallback for the other.
          const instance = bridge.credentials === 'environment'
            ? (deps.environmentCredentials ?? environmentCredentials)()
            : await (deps.credentials ?? (() => imdsCredentials({ fetchImpl: deps.fetchImpl })))();
          // With a dedicated role these credentials only sign the exchange; S3 gets the role's.
          const credentials = bridge.roleArn
            ? await (deps.assumeRole ?? assumeRole)({
              roleArn: bridge.roleArn, sessionName: 'agent-memory-bridge', region: bridge.region, credentials: instance,
              fetchImpl: deps.fetchImpl, signal,
            })
            : instance;
          return (deps.createS3 ?? createS3)({
            bucket: bridge.bucket, region: bridge.region, credentials, fetchImpl: deps.fetchImpl, signal,
          });
        });
      } catch (err) {
        s3Error = timeLimit(err) ? 'time limit' : errorText(err, 'credentials failed: 0 Unavailable');
      }
    }

    if (want.up) {
      if (s3Error !== null) {
        result.up = failure(s3Error, at);
      } else if (late()) {
        result.up = failure('no time left after the sync', at);
      } else {
        try {
          result.up = upRecord(await within(() => (deps.runBridgeUp ?? runBridgeUp)({ config, s3, now, signal, deadline: stepDeadline })), at);
        } catch (err) {
          result.up = failure(timeLimit(err) ? 'time limit' : errorText(err, 'bridge up failed'), at);
        }
      }
    }

    if (want.down) {
      if (bridge.down === true && s3Error !== null) {
        result.down = failure(s3Error, at);
      } else if (late()) {
        // Not started: the earlier step used the time up, or there was none to begin with.
        result.down = failure(want.up ? 'time limit' : 'no time left after the sync', at);
      } else {
        try {
          result.down = downRecord(
            await within(() => (deps.runBridgeDown ?? runBridgeDown)({
              config, s3: bridge.down === true ? s3 : null, signal, deadline: stepDeadline,
            })),
            at,
          );
        } catch (err) {
          result.down = failure(timeLimit(err) ? 'time limit' : errorText(err, 'bridge down failed'), at);
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return result;
}

// What sync.mjs runs: the bridge inside the time the unit has left. `startedAt` is the clock reading
// (milliseconds) when the run began. After a failed sync the result keeps each configured step as
// it was (`undefined`; see writeStatus) and leaves the others `null`. Null without a bridge block.
export async function bridgeAfterSync({
  config, syncResult, startedAt, clock = Date.now, deps, now = new Date(),
}) {
  const bridge = config?.bridge ?? null;
  if (bridge === null) return null;
  const want = configuredSteps(bridge);
  if (syncResult?.ok !== true) return { up: want.up ? undefined : null, down: want.down ? undefined : null };
  const limitMs = bridgeLimitMs(clock() - startedAt);
  if (limitMs < MIN_BRIDGE_MS) {
    const at = now.toISOString();
    return {
      up: want.up ? failure('no time left after the sync', at) : null,
      down: want.down ? failure('no time left after the sync', at) : null,
    };
  }
  return runBridge({ config, syncResult, deps, now, limitMs, processStart: startedAt, clock });
}
