// One bridge run, without a sync before it: started through `run.sh bridge [--time-limit <seconds>]`,
// for example by a GitHub Actions job whose checkout already is the notes repository. It runs the
// configured steps of the `bridge` block once and prints one line per step:
//   agent-memory bridge up: <JSON>
//   agent-memory bridge down: <JSON>
// The JSON is the step's record as bridge.mjs builds it (fixed words, numbers and a time; never a
// path, a key, a URL or text from the bucket or a remote). Nothing is written to status.json. The
// notes clone gets no new branch, index entry or work-tree file: bridge up reads it and may run
// `git fetch` there (which adds objects and writes FETCH_HEAD); bridge down only reads its origin
// URL. The step's own state file (<stateDir>/bridge.json) is written as in a sync run.
//
// Exit codes: 0 every configured step ok; 1 a step failed; 2 no bridge configured (no block, or a
// block that configures no step) or bad usage
// (`run.sh` adds 75 when a sync holds the lock).
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './lib/config.mjs';

const DEFAULT_SECONDS = 300;
const MIN_SECONDS = 10;
const MAX_SECONDS = 1800;
const USAGE = `usage: run.sh bridge [--time-limit <seconds, ${MIN_SECONDS} to ${MAX_SECONDS}, default ${DEFAULT_SECONDS}>]`;

// The seconds of the limit, or null when the arguments are not valid.
export function parseArgs(argv) {
  if (argv.length === 0) return DEFAULT_SECONDS;
  if (argv.length !== 2 || argv[0] !== '--time-limit' || !/^\d{1,5}$/.test(argv[1])) return null;
  const seconds = Number(argv[1]);
  return seconds >= MIN_SECONDS && seconds <= MAX_SECONDS ? seconds : null;
}

// Returns the exit code. `deps` (tests): runBridge, stdout and stderr (functions taking text).
export async function bridgeRun({ argv, config, deps = {}, now = new Date() }) {
  const out = deps.stdout ?? ((text) => process.stdout.write(text));
  const err = deps.stderr ?? ((text) => process.stderr.write(text));
  const seconds = parseArgs(argv);
  if (seconds === null) {
    err(`${USAGE}\n`);
    return 2;
  }
  if (!config?.bridge) {
    out('agent-memory: no bridge is configured.\n');
    return 2;
  }
  let result;
  try {
    // Loaded only here, so that a machine without a bridge block never loads the bridge modules.
    const bridgeModule = await import('./lib/bridge.mjs');
    const want = bridgeModule.configuredSteps(config.bridge);
    if (!want.up && !want.down) {
      out('agent-memory: no bridge is configured.\n');
      return 2;
    }
    const run = deps.runBridge ?? bridgeModule.runBridge;
    result = await run({ config, syncResult: { ok: true }, now, limitMs: seconds * 1000, deps: deps.bridgeDeps });
  } catch {
    err('agent-memory bridge could not run\n');
    return 1;
  }
  const steps = ['up', 'down'].filter((name) => result?.[name] != null);
  for (const name of steps) out(`agent-memory bridge ${name}: ${JSON.stringify(result[name])}\n`);
  return steps.length > 0 && steps.every((name) => result[name].ok === true) ? 0 : 1;
}

const isMain = process.argv[1] !== undefined && (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exitCode = await bridgeRun({ argv: process.argv.slice(2), config: loadConfig() });
  // A request left behind at the time limit must not keep the process alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
}
