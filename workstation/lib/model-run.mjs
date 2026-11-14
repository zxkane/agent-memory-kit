// Runs the model command-line client in a work folder and reads its result.
// No dependencies. runModel never throws: every outcome is a returned value.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_SUMMARY_CHARS = 2000;
const KILL_GRACE_MS = 5000;
const DRAIN_MS = 200;
const INHERITED_ENV = ['HOME', 'PATH', 'LANG', 'TZ'];
const TOOLS = 'Read,Write,Edit,Glob,Grep';

// Fills a prompt template. `{{#if name}}...{{/if}}` blocks (not nested) are kept
// when vars[name] is truthy and dropped otherwise; `{{name}}` must be in vars.
// An unclosed block or a stray end marker is an error.
export function fillTemplate(template, vars = {}) {
  const withBlocks = template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, name, body) => (vars[name] ? body : ''),
  );
  if (withBlocks.includes('{{#if') || withBlocks.includes('{{/if}}')) {
    throw new Error('prompt template has an unclosed or stray if marker');
  }
  return withBlocks.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!Object.hasOwn(vars, name) || vars[name] === undefined) {
      throw new Error(`prompt variable missing: ${name}`);
    }
    return String(vars[name]);
  });
}

export function renderPrompt(kind, vars = {}) {
  if (kind !== 'extract' && kind !== 'organize') {
    throw new Error(`unknown prompt kind: ${kind}`);
  }
  return fillTemplate(readFileSync(join(PROMPTS_DIR, `${kind}.md`), 'utf8'), vars);
}

export function modelArgs({ prompt, model, maxTurns, maxBudgetUsd, addDirs = [] }) {
  const args = [
    '-p', prompt,
    '--restricted',
    '--tools', TOOLS,
    '--permission-mode', 'acceptEdits',
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format', 'json',
    '--model', model,
    '--max-turns', String(maxTurns),
    '--max-budget-usd', String(maxBudgetUsd),
  ];
  for (const dir of addDirs) args.push('--add-dir', dir);
  return args;
}

function failure(stopReason) {
  return { ran: false, stopReason, costUsd: null, turns: null, denials: 0, summary: '' };
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseOutput(text) {
  let data;
  try {
    data = JSON.parse(text.trim());
  } catch {
    return null;
  }
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

function summarize(data, timedOut) {
  let stopReason;
  if (timedOut) {
    stopReason = 'timeout';
  } else if (data.is_error === false && data.subtype === 'success') {
    stopReason = 'completed';
  } else {
    const subtype = nonEmptyString(data.subtype);
    stopReason =
      (subtype !== 'success' ? subtype : null) ?? nonEmptyString(data.terminal_reason) ?? 'error';
  }
  return {
    ran: true,
    stopReason,
    costUsd: finiteOrNull(data.total_cost_usd),
    turns: finiteOrNull(data.num_turns),
    denials: Array.isArray(data.permission_denials) ? data.permission_denials.length : 0,
    summary: typeof data.result === 'string' ? data.result.slice(0, MAX_SUMMARY_CHARS) : '',
  };
}

function childEnv(extra) {
  const env = {};
  for (const name of INHERITED_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, ...(extra ?? {}) };
}

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // group already gone
  }
}

export function runModel({ command, args = [], cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      resolve(failure('invalid-timeout'));
      return;
    }
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: childEnv(env),
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      });
    } catch {
      resolve(failure('spawn-failed'));
      return;
    }

    const chunks = [];
    let size = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    let termTimer = null;
    let killTimer = null;
    let drainTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      clearTimeout(drainTimer);
      resolve(result);
    };

    // Called once the child has exited (or its pipe closed): stop reading, tidy
    // the process group, and answer with what was read.
    const conclude = () => {
      if (settled) return;
      child.stdout.destroy();
      if (timedOut && child.pid !== undefined) killGroup(child.pid, 'SIGKILL');
      const data = overflow ? null : parseOutput(Buffer.concat(chunks).toString('utf8'));
      if (data) finish(summarize(data, timedOut));
      else finish(failure(timedOut ? 'timeout' : 'no-result'));
    };

    child.on('error', () => {
      // Failed to start (or to be signalled): there is no child to wait for.
      finish(failure(child.pid === undefined ? 'spawn-failed' : 'no-result'));
    });

    child.stdout.on('data', (chunk) => {
      if (overflow) return;
      if (size + chunk.length > MAX_STDOUT_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      size += chunk.length;
      chunks.push(chunk);
    });
    child.stdout.on('error', () => {});

    // A background process that inherited stdout can hold the pipe open after the
    // child is gone, so 'close' alone may never come: after 'exit', drain briefly.
    child.on('exit', () => {
      clearTimeout(termTimer);
      drainTimer = setTimeout(conclude, DRAIN_MS);
    });
    child.on('close', conclude);

    termTimer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        killGroup(child.pid, 'SIGKILL');
        drainTimer = setTimeout(conclude, DRAIN_MS);
      }, KILL_GRACE_MS);
    }, timeoutMs);
  });
}
