import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
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

function sameJson(text, value) {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
  } catch {
    return false;
  }
}

// The real path of `path`, which may not exist yet: its nearest existing ancestor is resolved.
function realPathWithTail(path) {
  let head = path;
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = dirname(head);
      if (parent === head) throw err;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

// True when a symbolic link sits on the way from `home` to <home>/<rel> (also one that points
// nowhere), or when the folder does not resolve to <real home>/<rel>. What is written there lands
// in whatever the link points at, often a repository the user manages.
function folderIsLinked(home, rel) {
  let path = home;
  for (const part of rel.split('/')) {
    path = join(path, part);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) return true;
  }
  try {
    return realPathWithTail(join(home, rel)) !== join(realpathSync(home), rel);
  } catch {
    return true;
  }
}

const LINKED = 'is a symbolic link or lies in a linked folder, so it was left unchanged.';

function codexTarget(home) {
  const file = join(home, '.codex/hooks.json');
  const stat = lstatSync(file, { throwIfNoEntry: false });
  return { file, stat, linked: stat?.isSymbolicLink() === true || folderIsLinked(home, '.codex') };
}

function kiroTarget(home) {
  const dir = join(home, '.kiro/hooks');
  const file = join(dir, 'agent-memory-kit.json');
  let text = null;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // Missing, or a dangling link: no content.
  }
  return {
    dir,
    file,
    linked: folderIsLinked(home, '.kiro/hooks'),
    current: text !== null && sameJson(text, kiroHookDocument()),
    marked: text !== null && text.includes(HOOK_MARKER),
  };
}

// The parsed content of a Codex hooks.json that is a regular file. Throws when it cannot be used.
function readCodexConfig(file, hooks) {
  let config;
  try {
    config = parseObject(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not valid JSON holding an object; fix it and run the installer again.`);
  }
  if (hooks) {
    const value = config.hooks;
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error(`${file} has an unexpected shape: "hooks" must be an object; fix it and run the installer again.`);
    }
    if (value?.SessionStart !== undefined && !Array.isArray(value.SessionStart)) {
      throw new Error(`${file} has an unexpected shape: "hooks.SessionStart" must be an array; fix it and run the installer again.`);
    }
  }
  return config;
}

// The content of a Codex file that is only read, or null when it cannot be read.
function readLinkedConfig(file) {
  try {
    return parseObject(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The Claude Code settings file: its target, parsed content and mode. Throws when unusable.
function readSettings(home) {
  const settingsPath = join(home, '.claude/settings.json');
  if (!existsSync(settingsPath)) return { settingsPath, exists: false, settings: {}, mode: 0o600, target: settingsPath };
  const target = realpathSync(settingsPath);
  const mode = statSync(target).mode & 0o777;
  let settings;
  try {
    settings = JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    throw new Error(`${settingsPath} is not valid JSON; fix it and run the installer again.`);
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${settingsPath} must contain a JSON object.`);
  }
  return { settingsPath, exists: true, settings, mode, target };
}

// Every validation `install` can fail on, without writing anything: the Claude Code settings
// file and a Codex hooks file that is an ordinary file. A linked file is only read, never fails.
// A file that is not JSON holding an object fails even without hooks, as `install` could not
// edit it either; the shape rules apply only when hooks are to be registered.
export function checkInstall({ home, hooks = true }) {
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('The home directory must be an absolute path.');
  readSettings(home);
  if (isDirectory(join(home, '.codex'))) {
    const { file, stat, linked } = codexTarget(home);
    if (stat && !linked) readCodexConfig(file, hooks);
  }
}

// What to do about the Codex hooks file: { action, file, text?, mode?, removes? }.
// Actions: 'write' (create or rewrite), 'unchanged', 'notice-add' and 'notice-remove' (a linked
// file, left alone), 'none'. Throws when a regular file cannot be used.
function decideCodex(home, hooks) {
  const { file, stat, linked } = codexTarget(home);
  if (linked) {
    const config = readLinkedConfig(file);
    if (hooks) return { action: hasCommand(config, 'SessionStart', toolCommand('codex')) ? 'none' : 'notice-add', file };
    return { action: config && hasOwnHook(config) ? 'notice-remove' : 'none', file };
  }
  if (!stat) {
    if (!hooks) return { action: 'none', file };
    return { action: 'write', file, text: `${JSON.stringify(mergeCodexHooks({}), null, 2)}\n`, mode: 0o600 };
  }
  const config = readCodexConfig(file, hooks);
  const next = hooks ? mergeCodexHooks(config) : removeHooks(config);
  if (JSON.stringify(next) === JSON.stringify(config)) return { action: 'unchanged', file };
  return { action: 'write', file, text: `${JSON.stringify(next, null, 2)}\n`, mode: stat.mode & 0o777, removes: !hooks };
}

// The same for the Kiro hook file: { action, file, dir }; actions as above plus 'remove'.
function decideKiro(home, hooks) {
  const kiro = kiroTarget(home);
  const { file, dir } = kiro;
  if (kiro.linked) {
    if (hooks) return { action: kiro.current ? 'none' : 'notice-add', file, dir };
    return { action: kiro.marked ? 'notice-remove' : 'none', file, dir };
  }
  if (hooks) {
    // A symbolic link at the file itself is replaced by a regular file.
    const isLink = lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() === true;
    return { action: kiro.current && !isLink ? 'unchanged' : 'write', file, dir };
  }
  return { action: kiro.marked ? 'remove' : 'none', file, dir };
}

// What a dry run reports for Codex and Kiro: nothing for a file that stays as it is.
export function planInstall({ home, hooks = true }) {
  const lines = [];
  if (isDirectory(join(home, '.codex'))) {
    const d = decideCodex(home, hooks);
    if (d.action === 'write') lines.push(d.removes ? `would remove the Codex session-start hook from ${d.file}` : `would register the Codex session-start hook (${d.file})`);
    else if (d.action === 'notice-add') lines.push(`would leave ${d.file} unchanged (it or its folder is a symbolic link) and print the hook entry to add`);
    else if (d.action === 'notice-remove') lines.push(`would leave ${d.file} unchanged (it or its folder is a symbolic link) and ask for the kit's hook to be removed by hand`);
  }
  if (isDirectory(join(home, '.kiro'))) {
    const d = decideKiro(home, hooks);
    if (d.action === 'write') lines.push(`would write ${d.file}`);
    else if (d.action === 'remove') lines.push(`would remove ${d.file}`);
    else if (d.action === 'notice-add') lines.push(`would leave ${d.dir} unchanged (it or its folder is a symbolic link) and print the hook document to save there`);
    else if (d.action === 'notice-remove') lines.push(`would leave ${d.file} unchanged (its folder is a symbolic link) and ask for it to be removed by hand`);
  }
  return lines;
}

// A stable path to the kit's launcher, so a hook file shared between machines needs no kit path.
// Silent when the kit is gone.
function writeLauncher(home, kitDir) {
  const dir = join(home, dirname(LAUNCHER_REL));
  mkdirSync(dirname(dir), { recursive: true });
  if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
  const run = `${kitDir}/workstation/run.sh`;
  const text = `#!/bin/sh\n# Written by agent-memory-kit setup. A stable path to the kit's launcher.\n[ -x "${run}" ] || exit 0\nexec "${run}" "$@"\n`;
  writeAtomic(join(home, LAUNCHER_REL), text, 0o755);
}

const TRUST_NOTICE = 'Codex: start a session and run /hooks to trust the new hook; Codex skips it until then.';

// Carries out what decideCodex says and returns notices for the user. A file that is a symbolic
// link, or lies in a linked folder, is never written, created or removed.
function installCodex(home, hooks) {
  const d = decideCodex(home, hooks);
  switch (d.action) {
    case 'notice-add': {
      const entry = JSON.stringify({ hooks: { SessionStart: [codexEntry()] } }, null, 2);
      return [`Codex: ${d.file} ${LINKED} Add this hook to it:\n${entry}`, TRUST_NOTICE];
    }
    case 'notice-remove':
      return [`Codex: ${d.file} ${LINKED} Remove the agent-memory-kit hook from it.`];
    case 'write':
      writeAtomic(d.file, d.text, d.mode);
      return d.removes ? [] : [TRUST_NOTICE];
    default:
      return [];
  }
}

function installKiro(home, hooks) {
  const d = decideKiro(home, hooks);
  switch (d.action) {
    case 'notice-add': {
      const document = JSON.stringify(kiroHookDocument(), null, 2);
      return [`Kiro: ${d.dir} ${LINKED} Save this document there as a regular file named agent-memory-kit.json:\n${document}`];
    }
    case 'notice-remove':
      return [`Kiro: ${d.file} lies in a linked folder and was left unchanged. Remove it by hand.`];
    case 'write':
      mkdirSync(d.dir, { recursive: true });
      writeAtomic(d.file, `${JSON.stringify(kiroHookDocument(), null, 2)}\n`, 0o644);
      return [];
    case 'remove':
      rmSync(d.file);
      return [];
    default:
      return [];
  }
}

// With `hooks: false` the hooks are not registered, and entries added earlier are removed.
// Returns { notices }: text for the user, such as a hook to add by hand.
export async function install({ home, kitDir, hooks = true }) {
  if (typeof kitDir !== 'string' || !isAbsolute(kitDir) || UNSAFE_PATH.test(kitDir)) {
    throw new Error('The kit directory must be an absolute path without quotes, "$", backticks, backslashes or newlines.');
  }
  checkInstall({ home, hooks });
  const { settingsPath, exists, settings, mode, target } = readSettings(home);

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
  if (isDirectory(join(home, '.kiro'))) notices.push(...installKiro(home, hooks));
  return { notices };
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self)) {
  try {
    const args = process.argv.slice(2);
    const modes = ['--check', '--plan'].filter((m) => args.includes(m));
    if (args.some((a) => !['--no-hooks', '--check', '--plan'].includes(a)) || modes.length > 1) {
      throw new Error('usage: install.mjs [--check | --plan] [--no-hooks]');
    }
    const hooks = !args.includes('--no-hooks');
    if (modes[0] === '--check') {
      checkInstall({ home: homedir(), hooks });
    } else if (modes[0] === '--plan') {
      for (const line of planInstall({ home: homedir(), hooks })) process.stdout.write(`${line}\n`);
    } else {
      const { notices } = await install({ home: homedir(), kitDir: resolve(dirname(self), '..'), hooks });
      for (const notice of notices) process.stdout.write(`${notice}\n`);
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
