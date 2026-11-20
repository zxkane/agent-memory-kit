import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_LOG_KEEP_DAYS, appendRunLine, readRunLog } from '../lib/run-log.mjs';
import { tempDir } from './helpers.mjs';

const DAY_MS = 24 * 3600 * 1000;
const NOW = new Date('2026-11-20T12:00:00.000Z');
const ended = (daysAgo, extra = {}) => ({ schemaVersion: 1, kind: 'organize', endedAt: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(), ...extra });
const lines = (file) => readFileSync(file, 'utf8').split('\n');

test('appendRunLine adds one line to a private log in a private folder', (t) => {
  const state = join(tempDir(t), 'state');
  appendRunLine(state, ended(0, { runId: 'one' }), NOW);
  appendRunLine(state, ended(0, { runId: 'two' }), NOW);
  const file = join(state, 'runs.jsonl');
  assert.equal(statSync(state).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(lines(file).map((l) => (l === '' ? '' : JSON.parse(l).runId)), ['one', 'two', '']);
  assert.deepEqual(readRunLog(state).runs.map((r) => r.runId), ['one', 'two']);
});

test(`appendRunLine drops the lines that ended more than ${RUN_LOG_KEEP_DAYS} days before; it keeps those it cannot date`, (t) => {
  const state = tempDir(t);
  const file = join(state, 'runs.jsonl');
  writeFileSync(file, [
    JSON.stringify(ended(RUN_LOG_KEEP_DAYS + 1, { runId: 'old' })),
    JSON.stringify(ended(RUN_LOG_KEEP_DAYS, { runId: 'edge' })),
    'not json at all',
    '',
    JSON.stringify({ schemaVersion: 1, runId: 'undated' }),
    JSON.stringify(ended(3, { runId: 'recent' })),
  ].join('\n'));
  appendRunLine(state, ended(0, { runId: 'new' }), NOW);
  assert.deepEqual(lines(file), [
    JSON.stringify(ended(RUN_LOG_KEEP_DAYS, { runId: 'edge' })),
    'not json at all',
    JSON.stringify({ schemaVersion: 1, runId: 'undated' }),
    JSON.stringify(ended(3, { runId: 'recent' })),
    JSON.stringify(ended(0, { runId: 'new' })),
    '',
  ]);
});

test('appendRunLine never reads or replaces a log that is not a regular file', (t) => {
  const dir = tempDir(t);
  const target = join(dir, 'elsewhere.jsonl');
  writeFileSync(target, 'kept\n');
  symlinkSync(target, join(dir, 'runs.jsonl'));
  assert.throws(() => appendRunLine(dir, ended(0), NOW), /runs\.jsonl is not a regular file/);
  assert.equal(readFileSync(target, 'utf8'), 'kept\n');
  const other = tempDir(t);
  mkdirSync(join(other, 'runs.jsonl'));
  assert.throws(() => appendRunLine(other, ended(0), NOW), /not a regular file/);
  assert.deepEqual(readRunLog(other), { runs: [], problems: [{ file: 'runs.jsonl', line: null, problem: 'the run log cannot be read' }] });
});

test('readRunLog gives the run lines in order and names every other line by its number', (t) => {
  const state = tempDir(t);
  assert.deepEqual(readRunLog(join(state, 'missing')), { runs: [], problems: [] });
  writeFileSync(join(state, 'runs.jsonl'), [
    JSON.stringify(ended(2, { runId: 'a' })),
    '{"schemaVersion": 1, "runId": "cut',
    JSON.stringify(ended(1, { schemaVersion: 2, runId: 'newer' })),
    JSON.stringify({ schemaVersion: 1, runId: 'undated' }),
    '[]',
    '',
    JSON.stringify(ended(0, { runId: 'b' })),
    '',
  ].join('\n'));
  const log = readRunLog(state);
  assert.deepEqual(log.runs.map((r) => r.runId), ['a', 'b']);
  assert.deepEqual(log.problems, [
    { file: 'runs.jsonl', line: 2, problem: 'not valid JSON' },
    { file: 'runs.jsonl', line: 3, problem: 'not a run line of schemaVersion 1' },
    { file: 'runs.jsonl', line: 4, problem: 'not a run line of schemaVersion 1' },
    { file: 'runs.jsonl', line: 5, problem: 'not a run line of schemaVersion 1' },
  ]);
  assert.equal(existsSync(join(state, 'missing')), false, 'reading creates nothing');
});
