import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOK_MARKER = '# agent-memory-kit';
export const LAUNCHER_REL = '.config/agent-memory/run.sh';

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

// The hook command for Codex and Kiro. It reaches the kit through a launcher at a fixed path
// under $HOME, so one hook file can be shared between machines, and is silent where the
// launcher is absent.
export function toolCommand(tool) {
  return `r="$HOME/${LAUNCHER_REL}"; [ ! -x "$r" ] || "$r" session-start ${tool} ${HOOK_MARKER}`;
}

function codexEntry() {
  return { hooks: [{ type: 'command', command: toolCommand('codex'), timeout: 20 }] };
}

// Removes every hook this kit added earlier, then appends the current Codex session-start hook.
export function mergeCodexHooks(config) {
  const out = removeHooks(config);
  const hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  hooks.SessionStart = [...(Array.isArray(hooks.SessionStart) ? hooks.SessionStart : []), codexEntry()];
  out.hooks = hooks;
  return out;
}

export function kiroHookDocument() {
  return {
    version: 'v1',
    hooks: [{
      name: 'agent-memory-session-start',
      description: 'Print the shared-memory indexes at session start.',
      trigger: 'SessionStart',
      action: { type: 'command', command: toolCommand('kiro') },
      timeout: 20,
    }],
  };
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

function isDirectory(path) {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
}

function parseObject(text) {
  const value = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
  return value;
}

function hasCommand(config, event, command) {
  const groups = config?.hooks?.[event];
  return Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => h?.command === command));
}

function hasOwnHook(config) {
  return Object.values(config?.hooks ?? {}).some(
    (groups) => Array.isArray(groups) && groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some(isOwn)),
  );
}

// A stable path to the kit's launcher, so a hook file shared between machines needs no kit path.
function writeLauncher(home, kitDir) {
  const dir = join(home, dirname(LAUNCHER_REL));
  mkdirSync(dirname(dir), { recursive: true });
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  const text = `#!/bin/sh\n# Written by agent-memory-kit setup. A stable path to the kit's launcher.\nexec "${kitDir}/workstation/run.sh" "$@"\n`;
  writeAtomic(join(home, LAUNCHER_REL), text, 0o755);
}

const TRUST_NOTICE = 'Codex: start a session and run /hooks to trust the new hook; Codex skips it until then.';

// Returns notices for the user. A symbolic link is never written: it usually points into a
// repository the user manages.
function installCodex(home, hooks) {
  const file = join(home, '.codex/hooks.json');
  const link = lstatSync(file, { throwIfNoEntry: false });
  if (link?.isSymbolicLink()) {
    let config = null;
    try {
      config = parseObject(readFileSync(file, 'utf8'));
    } catch {
      // A dangling link or an unreadable target counts as "no entry present".
    }
    const head = `Codex: ${file} is a symbolic link and was left unchanged.`;
    if (hooks) {
      if (hasCommand(config, 'SessionStart', toolCommand('codex'))) return [];
      const entry = JSON.stringify({ hooks: { SessionStart: [codexEntry()] } }, null, 2);
      return [`${head} Add this hook to the file it points to:\n${entry}`, TRUST_NOTICE];
    }
    return config && hasOwnHook(config) ? [`${head} Remove the agent-memory-kit hook from the file it points to.`] : [];
  }
  if (!link) {
    if (!hooks) return [];
    writeAtomic(file, `${JSON.stringify(mergeCodexHooks({}), null, 2)}\n`, 0o600);
    return [TRUST_NOTICE];
  }
  let config;
  try {
    config = parseObject(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON holding an object; fix it and run the installer again.`);
  }
  const next = hooks ? mergeCodexHooks(config) : removeHooks(config);
  if (JSON.stringify(next) === JSON.stringify(config)) return [];
  writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`, link.mode & 0o777);
  return hooks ? [TRUST_NOTICE] : [];
}

function installKiro(home, hooks) {
  const file = join(home, '.kiro/hooks/agent-memory-kit.json');
  if (hooks) {
    mkdirSync(dirname(file), { recursive: true });
    writeAtomic(file, `${JSON.stringify(kiroHookDocument(), null, 2)}\n`, 0o644);
  } else if (existsSync(file) && readFileSync(file, 'utf8').includes(HOOK_MARKER)) {
    rmSync(file);
  }
}

// With `hooks: false` the hooks are not registered, and entries added earlier are removed.
// Returns { notices }: text for the user, such as a hook to add by hand.
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
  if (hooks || (exists && JSON.stringify(merged) !== JSON.stringify(settings))) {
    if (!exists) mkdirSync(dirname(settingsPath), { recursive: true });
    writeAtomic(target, `${JSON.stringify(merged, null, 2)}\n`, mode);
  }

  writeLauncher(home, kitDir);
  const notices = [];
  if (isDirectory(join(home, '.codex'))) notices.push(...installCodex(home, hooks));
  if (isDirectory(join(home, '.kiro'))) installKiro(home, hooks);
  return { notices };
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((a) => a !== '--no-hooks')) throw new Error('usage: install.mjs [--no-hooks]');
    const { notices } = await install({ home: homedir(), kitDir: resolve(dirname(self), '..'), hooks: !args.includes('--no-hooks') });
    for (const notice of notices) process.stdout.write(`${notice}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
