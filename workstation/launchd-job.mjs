// Bound each launchd run and keep only its latest output in a private local log.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';

export function runJob(command, args, { timeoutMs, graceMs = 15000, output = 'ignore' }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: ['ignore', output, output] });
    let timedOut = false; let killTimer;
    const signalGroup = (signal) => { try { process.kill(-child.pid, signal); } catch {} };
    const stop = () => {
      signalGroup('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => signalGroup('SIGKILL'), graceMs);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    const finish = (code) => {
      clearTimeout(timer); clearTimeout(killTimer);
      process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
      // A shell may exit before a descendant: ensure no orphan retains the sync lock.
      signalGroup('SIGKILL');
      resolve(timedOut ? 124 : code);
    };
    child.once('error', () => finish(1));
    child.once('exit', (code) => finish(code ?? 1));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const scope = process.argv[2]; const c = loadConfig();
  if (!['sync', 'extract', 'organize', 'canary'].includes(scope)) process.exitCode = 2;
  else if (c) {
    mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
    const fd = openSync(join(c.stateDir, `launchd-${scope}.log`), 'w', 0o600);
    try {
      const args = ['extract', 'organize'].includes(scope) ? ['consolidate', scope] : [scope];
      process.exitCode = await runJob(join(dirname(fileURLToPath(import.meta.url)), 'run.sh'), args,
        { timeoutMs: scope === 'sync' ? 120000 : scope === 'canary' ? 300000 : 14400000, output: fd });
    } finally { closeSync(fd); }
  }
}
