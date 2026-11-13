// One-time move of existing Claude Code memory folders. Started through `run.sh migrate`,
// which holds the sync lock for an --apply run.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { applyMigration, planMigration } from './lib/migrate.mjs';
import { runSync, writeStatus } from './lib/sync-engine.mjs';

const USAGE = 'usage: run.sh migrate --dry-run | --apply [--skip-flagged]\n';
const KNOWN = ['--dry-run', '--apply', '--skip-flagged'];

const args = process.argv.slice(2);
const flags = new Set(args);
const valid = args.length === flags.size
  && args.every((a) => KNOWN.includes(a))
  && flags.has('--dry-run') !== flags.has('--apply')
  && (!flags.has('--skip-flagged') || flags.has('--apply'));

if (!valid) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const config = loadConfig();
if (!config) {
  process.stderr.write('agent-memory is not enabled on this machine.\n');
  process.exit(1);
}

if (!existsSync(join(config.repoDir, '.git'))) {
  process.stderr.write(`agent-memory: ${config.repoDir} is not a clone; run setup.sh first.\n`);
  process.exit(1);
}

try {
  if (flags.has('--dry-run')) {
    const items = planMigration(config);
    const out = [];
    for (const item of items) {
      const where = item.action === 'adopt' ? `-> ${item.project}` : `skip (${item.reason})`;
      out.push(`${item.slug}  ${item.files} file(s)  ${where}  ${item.findings.length} finding(s)`);
      for (const f of item.findings) out.push(`  ${f.file} ${f.id} line ${f.line}`);
    }
    const adopt = items.filter((i) => i.action === 'adopt').length;
    const findings = items.reduce((n, i) => n + i.findings.length, 0);
    out.push(`${items.length} folder(s): ${adopt} to adopt, ${items.length - adopt} skipped, ${findings} finding(s)`);
    process.stdout.write(`${out.join('\n')}\n`);
  } else {
    // One sync first, so that the clone and the project markers in it are current.
    const sync = writeStatus(config, runSync(config));
    if (!sync.ok) {
      process.stderr.write(`agent-memory migrate: the sync before migrating failed: ${sync.error}\n`);
      process.exit(1);
    }
    const result = applyMigration(planMigration(config), config, { skipFlagged: flags.has('--skip-flagged') });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (err) {
  const hint = err.message === 'flagged files present'
    ? '. Run --dry-run to see them, then use --apply --skip-flagged to leave them out of the copy'
    : '';
  process.stderr.write(`agent-memory migrate failed: ${err?.message ?? err}${hint}\n`);
  process.exit(1);
}
