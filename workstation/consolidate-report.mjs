// `run.sh consolidate report [--since <YYYY-MM-DD> | --days <n>] [--format json|md]`: what
// consolidation did in a window of time (lib/run-report.mjs), as JSON for a program or as a short
// text for a terminal. run.sh starts it without a lock. Read-only: no network, no model, nothing
// written; it loads no AWS code and no module of the label client.
import { loadConfig } from './lib/config.mjs';
import { REPORT_USAGE, consolidationReport, parseReportArgs, reportSummary } from './lib/run-report.mjs';

const now = new Date();
const args = parseReportArgs(process.argv.slice(2), now);
const config = args === null ? null : loadConfig();
if (args === null) {
  process.stderr.write(`${REPORT_USAGE}\n`);
  process.exitCode = 2;
} else if (config === null) {
  process.stderr.write('agent-memory is not enabled on this machine.\n');
  process.exitCode = 1;
} else {
  try {
    const report = consolidationReport({ config, now, since: args.since });
    process.stdout.write(args.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : reportSummary(report));
  } catch (err) {
    process.stderr.write(`agent-memory consolidate report failed: ${String(err?.message ?? err).split('\n')[0]}\n`);
    process.exitCode = 1;
  }
}
