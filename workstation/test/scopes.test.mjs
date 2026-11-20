import assert from 'node:assert/strict';
import test from 'node:test';
import { REVISIT_MS, organizeDue, organizeScopes } from '../lib/scopes.mjs';

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
