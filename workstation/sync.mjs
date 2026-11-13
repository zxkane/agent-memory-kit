// One sync run. Started only through `run.sh sync`, which holds the lock.
import { loadConfig } from './lib/config.mjs';
import { runSync, writeStatus } from './lib/sync-engine.mjs';

const config = loadConfig();
if (config) {
  try {
    const status = writeStatus(config, runSync(config));
    if (!status.ok) {
      process.stderr.write(`agent-memory sync failed: ${status.error}\n`);
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`agent-memory sync could not record its status: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}
