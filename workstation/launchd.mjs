// macOS scheduling. The sync and consolidation logic remains in workstation/run.sh.
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';

const MARKER = '<!-- Managed by agent-memory-kit setup.sh. -->';
const PREFIX = 'io.github.agent-memory-kit.';
const scopes = ['sync', 'extract', 'organize', 'canary'];
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const xml = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
function value(v) {
  if (typeof v === 'boolean') return `<${v}/>`;
  if (typeof v === 'number') return `<integer>${v}</integer>`;
  if (Array.isArray(v)) return `<array>${v.map(value).join('')}</array>`;
  if (typeof v === 'object') return `<dict>${Object.entries(v).map(([k, x]) => `<key>${xml(k)}</key>${value(x)}`).join('')}</dict>`;
  return `<string>${xml(v)}</string>`;
}

// launchd's calendar is local wall time. Refuse other systemd expressions rather than
// silently scheduling them in a different time zone or at a different frequency.
export function calendarInterval(text) {
  const m = /^(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat) )?\*-\*-\* (\d{2}):(\d{2})(?::00)?$/.exec(text);
  if (!m || +m[2] > 23 || +m[3] > 59) throw new Error('use [Sun|Mon|Tue|Wed|Thu|Fri|Sat ]*-*-* HH:MM in local time');
  return { ...(m[1] ? { Weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(m[1]) } : {}), Hour: +m[2], Minute: +m[3] };
}

export function planLaunchd({ home, kitDir, nodeBin, config = {}, env = process.env }) {
  const dir = join(home, 'Library/LaunchAgents');
  const jobs = []; const notices = [];
  for (const scope of scopes) {
    const label = `${PREFIX}${scope}`;
    const path = join(dir, `${label}.plist`);
    const problem = scope === 'canary' ? config.canaryProblem : config.consolidateProblem;
    const schedule = scope === 'canary' ? config.canary?.schedule : config.consolidate?.[scope];
    if (scope !== 'sync' && problem) {
      notices.push(`${scope}: invalid configuration; existing LaunchAgent left unchanged.`);
      continue;
    }
    let interval;
    if (scope !== 'sync' && schedule) {
      try { interval = calendarInterval(schedule); } catch (e) {
        notices.push(`${scope}: unsupported macOS schedule (${e.message}); existing LaunchAgent left unchanged.`);
        continue;
      }
    }
    if (scope !== 'sync' && !schedule) { jobs.push({ scope, path, label, remove: true }); continue; }
    const plist = {
      Label: label,
      ProgramArguments: [nodeBin, join(kitDir, 'workstation/launchd-job.mjs'), scope],
      EnvironmentVariables: {
        // launchd does not run the user's shell initialization. Retain only the
        // standard proxy variables needed to reach the same Git remotes.
        ...Object.fromEntries(PROXY_KEYS.filter((k) => typeof env[k] === 'string' && env[k] !== '').map((k) => [k, env[k]])),
        HOME: home,
        PATH: [dirname(nodeBin), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.local/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
      },
      ...(scope === 'sync' ? { RunAtLoad: true, StartInterval: 120 } : { StartCalendarInterval: interval }),
      ProcessType: 'Background', LowPriorityIO: true, Umask: 63,
    };
    // This argument is visible in launchctl print and identifies the actual loaded
    // definition, even after login or a manual bootstrap of a staged plist.
    const signature = `agent-memory-job-${createHash('sha256').update(JSON.stringify(plist)).digest('hex')}`;
    plist.ProgramArguments.push(signature);
    const text = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n${MARKER}\n<plist version="1.0">${value(plist)}</plist>\n`;
    jobs.push({ scope, path, label, text, signature });
  }
  return { jobs, notices };
}

function current(job) {
  const st = lstatSync(job.path, { throwIfNoEntry: false });
  if (!st) return null;
  if (st.isSymbolicLink()) throw new Error(`${job.path} is a symbolic link; left unchanged.`);
  const text = readFileSync(job.path, 'utf8');
  if (!text.includes(MARKER) || !text.includes(`<string>${job.label}</string>`)) throw new Error(`${job.path} is not managed by this kit; left unchanged.`);
  return text;
}

export function installLaunchd({ home, kitDir, nodeBin, config = {}, env = process.env, dryRun = false, enable = true, check = false,
  exec = (args) => spawnSync('launchctl', args, { encoding: 'utf8' }), log = () => {} }) {
  const plan = planLaunchd({ home, kitDir, nodeBin, config, env });
  const jobs = plan.jobs.map((job) => ({ ...job, before: current(job) }));
  const domain = `gui/${process.getuid()}`;
  const call = (args) => { const r = exec(args); if (r.status !== 0) throw new Error(`launchctl ${args[0]} failed; retry from a logged-in macOS session.`); };
  for (const line of plan.notices) log(line);
  if (check) return plan;
  if (dryRun) {
    for (const job of jobs) if (!job.remove || job.before !== null) log(`would ${job.remove ? 'remove' : 'write'} ${job.path}`);
    if (enable) log('would enable and bootstrap the configured LaunchAgents');
    return plan;
  }
  // Check every job before changing any file. An unchanged running job needs no reload.
  for (const job of jobs) {
    if (!enable && !job.remove) continue;
    if (job.remove && job.before === null) continue;
    const r = exec(['print', `${domain}/${job.label}`]);
    job.loaded = r.status === 0;
    job.loadedCurrent = !job.remove && String(r.stdout ?? '').includes(job.signature);
    if (job.loaded && (job.remove || !job.loadedCurrent) && /\bstate = running\b/.test(r.stdout ?? '')) {
      throw new Error(`${job.label} is running; retry after it finishes.`);
    }
  }
  for (const job of jobs) {
    const service = `${domain}/${job.label}`;
    if (job.remove) {
      if (job.before === null) continue;
      if (job.loaded) call(['bootout', service]);
      rmSync(job.path); log(`removed ${job.path}`); continue;
    }
    if (enable && job.loaded && !job.loadedCurrent) {
      call(['bootout', service]); job.loaded = false;
    }
    if (job.before !== job.text) {
      mkdirSync(dirname(job.path), { recursive: true });
      const temp = `${job.path}.tmp.${process.pid}`;
      try { writeFileSync(temp, job.text, { flag: 'wx', mode: 0o600 }); renameSync(temp, job.path); }
      finally { rmSync(temp, { force: true }); }
    }
    if (enable) {
      call(['enable', service]);
      if (!job.loaded) call(['bootstrap', domain, job.path]);
    }
    log(`${enable ? 'enabled' : 'wrote'} ${job.path}`);
  }
  return plan;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const flags = process.argv.slice(2);
    if (flags.some((f) => !['--dry-run', '--no-enable', '--check', '--initializing'].includes(f))) throw new Error('unknown launchd installer option');
    const config = loadConfig();
    if (!config && !(flags.includes('--initializing') && (flags.includes('--check') || flags.includes('--dry-run')))) throw new Error('configuration is missing, invalid or disabled; LaunchAgents left unchanged');
    installLaunchd({ home: process.env.HOME, kitDir: dirname(dirname(fileURLToPath(import.meta.url))), nodeBin: process.execPath,
      config: config ?? {}, dryRun: flags.includes('--dry-run'), enable: !flags.includes('--no-enable'), check: flags.includes('--check'), log: console.log });
  } catch (e) { console.error(`agent-memory: ${e.message}`); process.exitCode = 1; }
}
