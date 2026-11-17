import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { calendarInterval, planLaunchd, installLaunchd } from '../launchd.mjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'memory-launchd-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'another home'); mkdirSync(home);
  return { home, kitDir: '/opt/kit', nodeBin: process.execPath, config: { stateDir: join(home, '.local/state/agent-memory') } };
}

test('calendar subset uses local time and rejects unsupported schedules', () => {
  assert.deepEqual(calendarInterval('Sun *-*-* 03:15'), { Weekday: 0, Hour: 3, Minute: 15 });
  assert.deepEqual(calendarInterval('*-*-* 04:30:00'), { Hour: 4, Minute: 30 });
  for (const s of ['Sun *-*-* 03:15 UTC', 'daily', 'Sun *-*-* 25:00', 'Sun *-*-* 03:15:20']) assert.throws(() => calendarInterval(s));
});

test('dry-run changes no files or services; normal install preserves other jobs', (t) => {
  const f = fixture(t); const calls = []; const exec = (args) => { calls.push(args); return { status: args[0] === 'print' ? 1 : 0, stdout: '' }; };
  installLaunchd({ ...f, dryRun: true, exec });
  assert.deepEqual(calls, []); assert.equal(existsSync(join(f.home, 'Library')), false);
  const dir = join(f.home, 'Library/LaunchAgents'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'other.plist'), 'preserve');
  installLaunchd({ ...f, exec });
  assert.equal(readFileSync(join(dir, 'other.plist'), 'utf8'), 'preserve');
  assert.ok(calls.some((a) => a[0] === 'bootstrap'));
  const plan = planLaunchd(f); const xml = readFileSync(plan.jobs[0].path, 'utf8');
  assert.ok(xml.includes('120')); assert.ok(xml.includes(f.home));
  const parsed = spawnSync('python3', ['-c', 'import plistlib,sys; p=plistlib.loads(sys.stdin.buffer.read()); assert p["EnvironmentVariables"]["HOME"]==sys.argv[1]; assert p["ProgramArguments"][2]=="sync"', f.home], { input: xml });
  assert.equal(parsed.status, 0, parsed.stderr?.toString());
});

test('no-enable writes plists without launchctl calls; repeat install does not reload a running unchanged job', (t) => {
  const f = fixture(t); const calls = [];
  installLaunchd({ ...f, enable: false, exec: (a) => { calls.push(a); return { status: 0 }; } });
  assert.deepEqual(calls, []);
  installLaunchd({ ...f, exec: (a) => ({ status: a[0] === 'print' ? 1 : 0 }) });
  installLaunchd({ ...f, exec: (a) => { calls.push(a); return { status: 0, stdout: `state = running\n${planLaunchd(f).jobs[0].signature}` }; } });
  assert.equal(calls.filter((a) => a[0] === 'bootstrap' || a[0] === 'bootout').length, 0);
});

test('changed running job and foreign or linked plist are preserved', (t) => {
  const f = fixture(t); installLaunchd({ ...f, enable: false });
  const file = planLaunchd(f).jobs[0].path; const old = readFileSync(file, 'utf8');
  assert.throws(() => installLaunchd({ ...f, nodeBin: '/new/node', exec: () => ({ status: 0, stdout: 'state = running' }) }), /running/);
  assert.equal(readFileSync(file, 'utf8'), old);
  writeFileSync(file, 'not managed'); assert.throws(() => installLaunchd({ ...f, enable: false }), /not managed/);
  rmSync(file); const target = join(f.home, 'outside'); writeFileSync(target, old); symlinkSync(target, file);
  assert.throws(() => installLaunchd({ ...f, enable: false }), /symbolic link/);
  assert.equal(readFileSync(target, 'utf8'), old);
});

test('removed schedule is unloaded and removed; invalid or unsupported schedule leaves its plist intact', (t) => {
  const f = fixture(t); f.config.consolidate = { extract: 'Sun *-*-* 03:00' };
  installLaunchd({ ...f, enable: false }); const file = planLaunchd(f).jobs.find((j) => j.scope === 'extract').path;
  const old = readFileSync(file, 'utf8');
  f.config.consolidate.extract += ' UTC'; installLaunchd({ ...f, enable: false });
  assert.equal(readFileSync(file, 'utf8'), old);
  f.config.consolidate = null; f.config.consolidateProblem = 'extract'; installLaunchd({ ...f, enable: false });
  assert.equal(readFileSync(file, 'utf8'), old);
  f.config.consolidateProblem = null; const calls = [];
  installLaunchd({ ...f, enable: false, exec: (a) => { calls.push(a); return { status: a[0] === 'print' ? 1 : 0 }; } });
  assert.equal(existsSync(file), false);
});

test('job runner reports command failure and terminates a process at its deadline', async () => {
  const { runJob } = await import('../launchd-job.mjs');
  assert.equal(await runJob(process.execPath, ['-e', 'process.exit(7)'], { timeoutMs: 3000 }), 7);
  assert.equal(await runJob(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 150, graceMs: 50 }), 124);
});


test('no-enable followed by enable reloads the old loaded job even when its disk plist already changed', (t) => {
  const f = fixture(t);
  installLaunchd({ ...f, exec: (a) => ({ status: a[0] === 'print' ? 1 : 0 }) });
  const newer = { ...f, nodeBin: '/new/node' };
  installLaunchd({ ...newer, enable: false });
  const calls = [];
  installLaunchd({ ...newer, exec: (a) => { calls.push(a); return { status: 0, stdout: 'state = not running' }; } });
  assert.ok(calls.some((a) => a[0] === 'bootout'));
  assert.ok(calls.some((a) => a[0] === 'bootstrap'));
});


test('a staged version loaded at login is detected from launchctl instead of stale disk state', (t) => {
  const f = fixture(t); installLaunchd({ ...f, exec: (a) => ({ status: a[0] === 'print' ? 1 : 0 }) });
  const newer = { ...f, nodeBin: '/new/node' }; installLaunchd({ ...newer, enable: false });
  const loaded = planLaunchd(newer).jobs[0].signature;
  const calls = []; installLaunchd({ ...f, exec: (a) => { calls.push(a); return { status: 0, stdout: `state = not running\n${loaded}` }; } });
  assert.ok(calls.some((a) => a[0] === 'bootout')); assert.ok(calls.some((a) => a[0] === 'bootstrap'));
});


test('missing config in the launchd CLI preserves existing scheduled jobs', (t) => {
  const f = fixture(t); f.config.consolidate = { extract: 'Sun *-*-* 03:00' };
  installLaunchd({ ...f, enable: false }); const file = planLaunchd(f).jobs.find((j) => j.scope === 'extract').path;
  const old = readFileSync(file, 'utf8');
  const cli = new URL('../launchd.mjs', import.meta.url);
  const r = spawnSync(process.execPath, [cli.pathname, '--no-enable'], { env: { ...process.env, HOME: f.home, AGENT_MEMORY_CONFIG: join(f.home, 'missing.json') }, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /configuration is missing/);
  assert.equal(readFileSync(file, 'utf8'), old);
});

test('scheduled jobs retain proxy routing but do not copy arbitrary environment secrets', (t) => {
  const f = fixture(t);
  const env = { HTTPS_PROXY: 'http://127.0.0.1:9001', https_proxy: 'http://127.0.0.1:9001', NO_PROXY: 'localhost', AWS_SECRET_ACCESS_KEY: 'must-not-be-inherited', HOME: '/wrong/home' };
  const job = planLaunchd({ ...f, env }).jobs[0];
  assert.ok(job.text.includes('<key>HTTPS_PROXY</key><string>http://127.0.0.1:9001</string>'));
  assert.ok(job.text.includes('<key>https_proxy</key>'));
  assert.ok(job.text.includes('<key>NO_PROXY</key><string>localhost</string>'));
  assert.ok(!job.text.includes('must-not-be-inherited'));
  assert.ok(!job.text.includes('/wrong/home'));
  assert.notEqual(job.signature, planLaunchd({ ...f, env: {} }).jobs[0].signature);
});
