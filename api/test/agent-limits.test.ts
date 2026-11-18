// The Organize run for agent scopes (workstation/lib/agent-scopes.mjs) rejects a result the API
// could not have written. Its copy of the API's rules must not drift from the API's own.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { API_LIMITS, isNotePath } from '../../workstation/lib/agent-scopes.mjs';
import { MAX_SCOPE_BYTES, MAX_SCOPE_NOTES, MAX_SNAPSHOT_BYTES } from '../src/ops/write.ts';
import { parseNotePath, parseWrite } from '../src/validate.ts';

const accepts = (fn: () => unknown): boolean => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};
const write = (fields: Record<string, unknown>) => () =>
  parseWrite({ agent: 'codex-alpha', name: 'note', description: 'A note', content: 'A fact.', ...fields });

describe('the agent-scope rules of the workstation job', () => {
  it('use the API\'s scope and snapshot limits', () => {
    assert.equal(API_LIMITS.scopeNotes, MAX_SCOPE_NOTES);
    assert.equal(API_LIMITS.scopeBytes, MAX_SCOPE_BYTES);
    assert.equal(API_LIMITS.snapshotBytes, MAX_SNAPSHOT_BYTES);
  });

  it('accept exactly the note names the API accepts', () => {
    for (const name of ['a', 'a-b-1', 'a'.repeat(80), 'a'.repeat(81), 'A', 'a_b', '-a', 'a.b', 'memory', '1']) {
      assert.equal(API_LIMITS.slug.test(name) && name !== 'memory', accepts(write({ name })), name);
    }
  });

  it('accept exactly the description lengths and content sizes the API accepts', () => {
    for (const n of [1, API_LIMITS.descriptionChars, API_LIMITS.descriptionChars + 1]) {
      assert.equal(n <= API_LIMITS.descriptionChars, accepts(write({ description: 'd'.repeat(n) })), `description ${n}`);
    }
    for (const n of [1, API_LIMITS.contentBytes, API_LIMITS.contentBytes + 1]) {
      assert.equal(n <= API_LIMITS.contentBytes, accepts(write({ content: 'c'.repeat(n) })), `content ${n}`);
    }
  });

  it('read a snapshot entry as a note exactly when the API reads its path as a note path', () => {
    for (const path of [
      'agents/codex-alpha/a.md', 'agents/Codex/a.md', 'agents/a/b/c.md', 'agents/codex-alpha/.a.md', 'agents/codex-alpha/a.txt',
      'global/a.md', 'projects/app/a.md', 'projects/.x/a.md', 'mem/global/a.md', 'a.md', '', `agents/${'a'.repeat(41)}/a.md`,
      `agents/codex-alpha/${'a'.repeat(197)}.md`, `agents/codex-alpha/${'a'.repeat(198)}.md`,
    ]) {
      assert.equal(isNotePath(path), accepts(() => parseNotePath(path)), path);
    }
  });
});
