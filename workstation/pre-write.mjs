// Claude Code PreToolUse hook: refuses a write into the notes clone when the
// new text contains a secret. Reports pattern ids only, never the text.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './lib/config.mjs';
import { isInside, logHookError } from './lib/context.mjs';
import { scanText } from './lib/secret-scan.mjs';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function newTexts(toolInput) {
  const texts = [toolInput.content, toolInput.new_string];
  if (Array.isArray(toolInput.edits)) texts.push(...toolInput.edits.map((e) => e?.new_string));
  return texts.filter((x) => typeof x === 'string');
}

const config = loadConfig();
if (config) {
  try {
    let input;
    try {
      input = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
      throw new Error('hook input is not valid JSON');
    }
    const toolInput = input?.tool_input;
    const filePath = toolInput?.file_path;
    if (WRITE_TOOLS.has(input?.tool_name) && typeof filePath === 'string' && filePath) {
      const base = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
      if (isInside(resolve(base, filePath), config.repoDir)) {
        const ids = [...new Set(newTexts(toolInput).flatMap((text) => scanText(text).map((f) => f.id)))];
        if (ids.length > 0) {
          const permissionDecisionReason = `Blocked by the agent-memory secret scan (${ids.join(', ')}). Memory notes are synced to a remote repository. Record where the secret is kept instead of its value.`;
          process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason } })}\n`);
        }
      }
    }
  } catch (err) {
    logHookError(config.stateDir, 'pre-write', err?.message ?? err);
  }
}
