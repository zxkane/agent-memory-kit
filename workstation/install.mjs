import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_MARKER = '# agent-memory-kit';

const UNSAFE_PATH = /["$`\\\n]/;

function isOwn(hook) {
  return typeof hook?.command === 'string' && hook.command.includes(HOOK_MARKER);
}

// Removes every hook this kit added earlier and keeps everything else.
export function removeHooks(config) {
  const out = structuredClone(config ?? {});
  const hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) {
        kept.push(group);
        continue;
      }
      const rest = group.hooks.filter((h) => !isOwn(h));
      if (rest.length === group.hooks.length) kept.push(group);
      else if (rest.length > 0) kept.push({ ...group, hooks: rest });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  return out;
}

// Removes every hook this kit added earlier, then appends the current two.
export function mergeHooks(config, runShPath) {
  const out = removeHooks(config);
  const hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  hooks.SessionStart = [
    ...(hooks.SessionStart ?? []),
    { hooks: [{ type: 'command', command: `"${runShPath}" session-start ${HOOK_MARKER}`, timeout: 20 }] },
  ];
  hooks.PreToolUse = [
    ...(hooks.PreToolUse ?? []),
    { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: `"${runShPath}" pre-write ${HOOK_MARKER}`, timeout: 10 }] },
  ];
  out.hooks = hooks;
  return out;
}

function writeAtomic(file, text, mode) {
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// With `hooks: false` the two hooks are not registered, and entries added earlier are removed.
export async function install({ home, kitDir, hooks = true }) {
  if (typeof kitDir !== 'string' || !isAbsolute(kitDir) || UNSAFE_PATH.test(kitDir)) {
    throw new Error('The kit directory must be an absolute path without quotes, "$", backticks, backslashes or newlines.');
  }
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('The home directory must be an absolute path.');

  const settingsPath = join(home, '.claude/settings.json');
  let settings = {};
  let mode = 0o600;
  let target = settingsPath;
  const exists = existsSync(settingsPath);
  if (exists) {
    target = realpathSync(settingsPath);
    mode = statSync(target).mode & 0o777;
    try {
      settings = JSON.parse(readFileSync(target, 'utf8'));
    } catch {
      throw new Error(`${settingsPath} is not valid JSON; fix it and run the installer again.`);
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(`${settingsPath} must contain a JSON object.`);
    }
  }

  const runSh = join(kitDir, 'workstation/run.sh');
  const merged = hooks ? mergeHooks(settings, runSh) : removeHooks(settings);
  writeFileSync(join(kitDir, 'workstation/node.local.path'), `${process.execPath}\n`);
  // Without hooks, a settings file is neither created nor rewritten when nothing changes.
  if (!hooks && (!exists || JSON.stringify(merged) === JSON.stringify(settings))) return;
  if (!exists) mkdirSync(dirname(settingsPath), { recursive: true });
  writeAtomic(target, `${JSON.stringify(merged, null, 2)}\n`, mode);
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((a) => a !== '--no-hooks')) throw new Error('usage: install.mjs [--no-hooks]');
    await install({ home: homedir(), kitDir: resolve(dirname(self), '..'), hooks: !args.includes('--no-hooks') });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
