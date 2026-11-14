// One sync run. Started only through `run.sh sync`, which holds the lock.
// The unit stops the run after 120 s. The sync has its own limits; one deadline, 110 s after the
// start, covers the bridge (see lib/bridge.mjs): when the sync alone takes more than about 105 s,
// less than 5 s are left and the bridge is not started.
import { loadConfig } from './lib/config.mjs';
import { runSync, writeStatus } from './lib/sync-engine.mjs';

// The record of each configured step when the bridge modules could not be used. This does not
// import them: it is what runs when they cannot be loaded.
function bridgeCouldNotRun(bridge, at) {
  const failure = () => ({ ok: false, status: null, error: 'bridge could not run', at: at.toISOString() });
  return {
    up: bridge.up === true ? failure() : null,
    down: typeof bridge.agentsRepoDir === 'string' && bridge.agentsRepoDir !== '' ? failure() : null,
  };
}

const startedAt = Date.now();
const config = loadConfig();
if (config) {
  try {
    const result = runSync(config);
    // `null`: no bridge is configured (the status file gets no bridge key). `undefined`: the bridge
    // could not be run at all, so the previous record stays as it was.
    let bridge = null;
    if (config.bridge) {
      // Loaded only here, so that a machine without a bridge block never loads the bridge modules.
      try {
        const { bridgeAfterSync } = await import('./lib/bridge.mjs');
        bridge = await bridgeAfterSync({ config, syncResult: result, startedAt });
      } catch {
        // The bridge could not be loaded or its wrapper threw: say so once, and record every
        // configured step as failed with a fixed text (nothing of the error is kept), so that the
        // health line shows it once the stale window has passed. After a failed sync the records
        // stay as they were, as when the bridge is not attempted.
        process.stderr.write('agent-memory bridge could not run\n');
        bridge = result.ok === true ? bridgeCouldNotRun(config.bridge, new Date()) : undefined;
      }
    }
    // A bridge step never changes the exit code: it only decides what the status file says.
    const status = writeStatus(config, result, new Date(), bridge);
    if (!status.ok) {
      process.stderr.write(`agent-memory sync failed: ${status.error}\n`);
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`agent-memory sync could not record its status: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
  // A bridge step that was left behind at its time limit must not keep the process alive.
  setTimeout(() => process.exit(process.exitCode ?? 0), 2000).unref();
}
