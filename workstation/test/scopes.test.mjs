import assert from 'node:assert/strict';
import test from 'node:test';
import { REVISIT_MS, globalLast, neverOrganized, organizeDue, organizeScopes } from '../lib/scopes.mjs';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const DAY_MS = 24 * 3600 * 1000;
const at = (ms) => new Date(ms).toISOString();
const info = (extra = {}) => ({ notes: 3, overLimit: false, conflict: false, digest: 'd1', ...extra });

test('organizeDue says why a scope is due for Organize, or null', () => {
  const organized = { organizedDigest: 'd1', lastOrganize: at(NOW - DAY_MS) };
  assert.equal(organizeDue(info(), undefined, NOW), 'never-organized');
  assert.equal(organizeDue(info(), {}, NOW), 'never-organized');
  assert.equal(organizeDue(info({ digest: 'd2' }), organized, NOW), 'changed');
  assert.equal(organizeDue(info(), organized, NOW), null);
  assert.equal(organizeDue(info({ notes: 0 }), undefined, NOW), null, 'a scope without notes is never due');
  // Unchanged but over the limits, or with a conflict copy: due again only after REVISIT_MS.
  assert.equal(organizeDue(info({ overLimit: true }), organized, NOW), null);
  assert.equal(organizeDue(info({ conflict: true }), organized, NOW), null);
  const old = { organizedDigest: 'd1', lastOrganize: at(NOW - REVISIT_MS - 1) };
  assert.equal(organizeDue(info({ overLimit: true }), old, NOW), 'over-limits');
  assert.equal(organizeDue(info({ overLimit: true, conflict: true }), old, NOW), 'over-limits');
  assert.equal(organizeDue(info({ conflict: true }), old, NOW), 'conflict');
  assert.equal(organizeDue(info({ conflict: true }), { organizedDigest: 'd1' }, NOW), 'conflict', 'no time counts as long ago');
  assert.equal(organizeDue(info(), old, NOW), null);
});

test('organizeScopes takes exactly the scopes organizeDue names', () => {
  const scan = {
    global: { usable: true, ...info({ digest: 'g' }) },
    projects: [
      { name: 'a', ...info({ digest: 'a' }) },
      { name: 'b', ...info({ digest: 'b2' }) },
      { name: 'c', ...info({ digest: 'c', overLimit: true }) },
      { name: 'd', ...info({ digest: 'd', notes: 0 }) },
      { name: 'e', ...info({ digest: 'e', conflict: true }) },
    ],
  };
  const state = {
    projects: {
      global: { organizedDigest: 'g', lastOrganize: at(NOW - DAY_MS) },
      b: { organizedDigest: 'b1', lastOrganize: at(NOW - DAY_MS) },
      c: { organizedDigest: 'c', lastOrganize: at(NOW - 30 * DAY_MS) },
      e: { organizedDigest: 'e', lastOrganize: at(NOW - 2 * DAY_MS) },
    },
  };
  const due = organizeScopes(scan, state, { projects: [] }, NOW).map((s) => s.scope);
  assert.deepEqual(due, ['c', 'a', 'b']);
  const infos = [{ name: 'global', ...scan.global }, ...scan.projects];
  assert.deepEqual(new Set(due), new Set(infos.filter((i) => organizeDue(i, state.projects[i.name], NOW) !== null).map((i) => i.name)));
  // Named scopes are all taken, in the order given.
  assert.deepEqual(organizeScopes(scan, state, { projects: ['d', 'global'] }, NOW), [{ scope: 'd' }, { scope: 'global' }]);
});

test('globalLast moves global/ behind the project scopes a run takes, and the run takes the same scopes', () => {
  const list = (...names) => names.map((scope) => ({ scope }));
  const order = (items, limit) => globalLast(items, limit).map((i) => i.scope);
  assert.deepEqual(order(list('global', 'a', 'b', 'c'), 2), ['a', 'global', 'b', 'c']);
  assert.deepEqual(order(list('a', 'global', 'b', 'c'), 3), ['a', 'b', 'global', 'c']);
  assert.deepEqual(order(list('global', 'a', 'b'), Infinity), ['a', 'b', 'global'], 'named scopes: global/ last of all');
  assert.deepEqual(order(list('global', 'a'), 5), ['a', 'global']);
  assert.deepEqual(order(list('a', 'b', 'global'), 2), ['a', 'b', 'global'], 'global/ not taken: the order stays');
  assert.deepEqual(order(list('a', 'global'), 5), ['a', 'global']);
  assert.deepEqual(order(list('global'), 5), ['global']);
  assert.deepEqual(order(list('global', 'a'), 1), ['global', 'a'], 'a run of one scope takes global/ alone');
  assert.deepEqual(order([], 5), []);
  const items = list('global', 'a');
  globalLast(items, 5);
  assert.deepEqual(items, list('global', 'a'), 'the list given is not changed');
});

test('never organized comes from one field, the time of the last organize, for the due rule and the report alike', () => {
  // A digest without a time: never organized, by both.
  const digestOnly = { organizedDigest: 'd0' };
  assert.equal(neverOrganized(digestOnly), true);
  assert.equal(organizeDue(info(), digestOnly, NOW), 'never-organized');
  // A time without a digest: organized once, and changed since.
  const timeOnly = { lastOrganize: at(NOW - DAY_MS) };
  assert.equal(neverOrganized(timeOnly), false);
  assert.equal(organizeDue(info(), timeOnly, NOW), 'changed');
  assert.equal(neverOrganized(undefined), true);
  assert.equal(neverOrganized({ lastOrganize: 'not a time', organizedDigest: 'd1' }), true);
  assert.equal(organizeDue(info({ digest: 'd2' }), { lastOrganize: 'not a time', organizedDigest: 'd1' }, NOW), 'never-organized');
});
