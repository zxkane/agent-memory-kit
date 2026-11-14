import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import fs, {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync,
  symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mergeIndex, adoptDir, ensureLink } from '../lib/link.mjs';
import { tempDir } from './helpers.mjs';

const linkModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../lib/link.mjs')).href;

const read = (dir, name) => readFileSync(join(dir, name), 'utf8');
const put = (dir, name, text) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
};

test('mergeIndex unions lines and rewrites renamed links', () => {
  const out = mergeIndex('- [A](a.md) — one\n', '- [A](a.md) — one\n- [B](b.md) — two\n', new Map([['b.md', 'b.alpha.md']]));
  assert.equal(out, '- [A](a.md) — one\n- [B](b.alpha.md) — two\n');
});

test('mergeIndex ignores trailing whitespace, returns empty for empty input', () => {
  assert.equal(mergeIndex('- [A](a.md)  \n', '- [A](a.md)\n- [C](c.md)', new Map()), '- [A](a.md)  \n- [C](c.md)\n');
  assert.equal(mergeIndex('', '', new Map()), '');
});

test('adoptDir copies, skips identical files and keeps both on a collision', (t) => {
  const base = tempDir(t);
  const src = join(base, 'src');
  const target = join(base, 'target');
  put(src, 'a.md', 'x');
  put(src, 'b.md', 'local');
  put(src, '中文 笔记.md', 'n');
  put(src, 'MEMORY.md', '- [A](a.md)\n- [B](b.md)\n');
  put(target, 'a.md', 'x');
  put(target, 'b.md', 'remote');
  const r = adoptDir(src, target, 'alpha');
  assert.deepEqual(r, { copied: 2, renamed: ['b.md -> b.alpha.md'] });
  assert.equal(read(target, 'b.md'), 'remote');
  assert.equal(read(target, 'b.alpha.md'), 'local');
  assert.equal(read(target, '中文 笔记.md'), 'n');
  assert.match(read(target, 'MEMORY.md'), /\]\(b\.alpha\.md\)/);
});

test('adoptDir keeps modification time and merges into an existing index', (t) => {
  const base = tempDir(t);
  const src = join(base, 'src');
  const target = join(base, 'target');
  put(src, 'a.md', 'x');
  put(src, 'MEMORY.md', '- [A](a.md)\n- [N](n.md)\n');
  put(target, 'MEMORY.md', '- [A](a.md)\n');
  const when = new Date('2026-01-02T03:04:05Z');
  utimesSync(join(src, 'a.md'), when, when);
  adoptDir(src, target, 'alpha');
  assert.equal(statSync(join(target, 'a.md')).mtimeMs, when.getTime());
  assert.equal(read(target, 'MEMORY.md'), '- [A](a.md)\n- [N](n.md)\n');
});

test('adoptDir leaves subdirectories and symlinks alone and honours skip', (t) => {
  const base = tempDir(t);
  const src = join(base, 'src');
  const target = join(base, 'target');
  put(src, 'a.md', 'x');
  put(src, 'skipme.md', 's');
  put(join(src, 'sub'), 'deep.md', 'd');
  symlinkSync(join(src, 'a.md'), join(src, 'link.md'));
  const r = adoptDir(src, target, 'alpha', { skip: new Set(['skipme.md']) });
  assert.deepEqual(r, { copied: 1, renamed: [] });
  assert.deepEqual(readdirSync(target), ['a.md']);
});

test('adoptDir picks a free collision name and skips an identical one', (t) => {
  const base = tempDir(t);
  const src = join(base, 'src');
  const target = join(base, 'target');
  put(src, 'b.md', 'local');
  put(src, 'c.md', 'same');
  put(target, 'b.md', 'remote');
  put(target, 'b.alpha.md', 'other');
  put(target, 'c.md', 'different');
  put(target, 'c.alpha.md', 'same');
  const r = adoptDir(src, target, 'alpha');
  assert.deepEqual(r, { copied: 1, renamed: ['b.md -> b.alpha-2.md'] });
  assert.equal(read(target, 'b.alpha.md'), 'other');
  assert.equal(read(target, 'b.alpha-2.md'), 'local');
  assert.deepEqual(readdirSync(target).sort(), ['b.alpha-2.md', 'b.alpha.md', 'b.md', 'c.alpha.md', 'c.md']);
});

test('adoptDir copies an incoming index through mergeIndex when the target has none', (t) => {
  const base = tempDir(t);
  const src = join(base, 'src');
  const target = join(base, 'target');
  put(src, 'b.md', 'local');
  put(src, 'MEMORY.md', '- [B](b.md)\n');
  put(target, 'b.md', 'remote');
  const r = adoptDir(src, target, 'alpha');
  assert.equal(r.copied, 1);
  assert.equal(read(target, 'MEMORY.md'), '- [B](b.alpha.md)\n');
});

test('ensureLink links a missing folder', (t) => {
  const base = tempDir(t);
  const linkPath = join(base, 'projects', 'p', 'memory');
  const targetDir = join(base, 'clone', 'notes');
  const r = ensureLink({ linkPath, targetDir, host: 'alpha' });
  assert.equal(r.action, 'linked');
  assert.equal(realpathSync(linkPath), realpathSync(targetDir));
});

test('ensureLink adopts a real folder and leaves a backup', (t) => {
  const base = tempDir(t);
  const linkPath = join(base, 'projects', 'p', 'memory');
  const targetDir = join(base, 'clone', 'notes');
  put(linkPath, 'note.md', 'hello');
  const r = ensureLink({ linkPath, targetDir, host: 'alpha', now: new Date('2026-11-13T07:00:00Z') });
  assert.equal(r.action, 'adopted');
  assert.equal(r.copied, 1);
  assert.equal(r.backupDir, join(dirname(linkPath), 'memory.local-backup-20261113T070000Z'));
  assert.ok(lstatSync(linkPath).isSymbolicLink());
  assert.equal(read(targetDir, 'note.md'), 'hello');
  assert.equal(read(r.backupDir, 'note.md'), 'hello');
});

test('ensureLink gives a second backup in the same second a suffix', (t) => {
  const base = tempDir(t);
  const linkPath = join(base, 'projects', 'p', 'memory');
  const targetDir = join(base, 'clone', 'notes');
  const now = new Date('2026-11-13T07:00:00Z');
  mkdirSync(join(dirname(linkPath), 'memory.local-backup-20261113T070000Z'), { recursive: true });
  put(linkPath, 'note.md', 'hello');
  const r = ensureLink({ linkPath, targetDir, host: 'alpha', now });
  assert.equal(r.backupDir, join(dirname(linkPath), 'memory.local-backup-20261113T070000Z-2'));
});

test('ensureLink is idempotent and leaves a foreign symlink alone', (t) => {
  const base = tempDir(t);
  const linkPath = join(base, 'projects', 'p', 'memory');
  const otherLink = join(base, 'projects', 'q', 'memory');
  const targetDir = join(base, 'clone', 'notes');
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(elsewhere);
  const opts = { linkPath, targetDir, host: 'alpha' };
  ensureLink(opts);
  assert.equal(ensureLink(opts).action, 'ok');
  mkdirSync(dirname(otherLink), { recursive: true });
  symlinkSync(elsewhere, otherLink);
  const r = ensureLink({ ...opts, linkPath: otherLink });
  assert.equal(r.action, 'skipped');
  assert.equal(r.reason, 'foreign-symlink');
  assert.equal(realpathSync(otherLink), realpathSync(elsewhere));
});

test('two concurrent adoptions lose nothing and leave one link', async (t) => {
  const base = tempDir(t);
  const linkPath = join(base, 'projects', 'p', 'memory');
  const targetDir = join(base, 'clone', 'notes');
  put(linkPath, 'note.md', 'hello');
  put(linkPath, 'MEMORY.md', '- [N](note.md)\n');
  const script = `import(${JSON.stringify(linkModule)}).then((m) => {
    process.stdout.write(JSON.stringify(m.ensureLink(JSON.parse(process.argv[1]))));
  });`;
  const run = () => new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', script, JSON.stringify({ linkPath, targetDir, host: 'alpha' })], (err, out) => {
      if (err) reject(err); else resolve(JSON.parse(out));
    });
  });
  const results = await Promise.all([run(), run()]);
  assert.ok(lstatSync(linkPath).isSymbolicLink());
  assert.deepEqual(readdirSync(targetDir).sort(), ['MEMORY.md', 'note.md']);
  assert.equal(read(targetDir, 'note.md'), 'hello');
  assert.equal(readdirSync(dirname(linkPath)).filter((n) => n.startsWith('memory.local-backup-')).length, 1);
  assert.deepEqual(readdirSync(dirname(linkPath)).filter((n) => n.endsWith('.adopt-lock')), []);
  assert.ok(results.every((r) => ['adopted', 'linked', 'ok'].includes(r.action)));
});

// Runs `act` once, at the point of the race inside ensureLink.
const once = (act) => {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    act();
  };
};

// A folder at linkPath next to a notes folder, as a session leaves it.
function setup(t, notes = { 'note.md': 'hello' }) {
  const base = tempDir(t);
  const linkPath = join(base, 'projects', 'p', 'memory');
  const targetDir = join(base, 'clone', 'notes');
  for (const [name, text] of Object.entries(notes)) put(linkPath, name, text);
  return { base, linkPath, targetDir, siblings: () => readdirSync(dirname(linkPath)).sort() };
}

test('a path another adoption has just linked is not reported as nested entries', (t) => {
  const { linkPath, targetDir } = setup(t);
  mkdirSync(join(targetDir, 'sub'), { recursive: true });
  const beforeNestedCheck = once(() => {
    fs.renameSync(linkPath, `${linkPath}.local-backup-other`);
    symlinkSync(targetDir, linkPath);
  });
  const r = ensureLink({ linkPath, targetDir, host: 'alpha' }, { beforeNestedCheck });
  assert.equal(r.action, 'ok');
  assert.ok(lstatSync(linkPath).isSymbolicLink());
});

test('a directory renamed away before the nested check is linked by the caller', (t) => {
  const { linkPath, targetDir } = setup(t);
  const beforeNestedCheck = once(() => fs.renameSync(linkPath, `${linkPath}.local-backup-other`));
  const r = ensureLink({ linkPath, targetDir, host: 'alpha' }, { beforeNestedCheck });
  assert.ok(['linked', 'ok'].includes(r.action));
  assert.equal(realpathSync(linkPath), realpathSync(targetDir));
});

test('a directory replaced by a file before the nested check is reported as not a directory', (t) => {
  const { linkPath, targetDir } = setup(t);
  const beforeNestedCheck = once(() => {
    fs.rmSync(linkPath, { recursive: true });
    writeFileSync(linkPath, 'now a file');
  });
  const r = ensureLink({ linkPath, targetDir, host: 'alpha' }, { beforeNestedCheck });
  assert.deepEqual([r.action, r.reason], ['skipped', 'not-a-directory']);
  assert.equal(readFileSync(linkPath, 'utf8'), 'now a file');
});

test('a folder replaced by a file while the first pass lists it is reported as not a directory', (t) => {
  const { linkPath, targetDir } = setup(t);
  let listings = 0;
  // Reads of linkPath: the check before the lock, the check under the lock, then the first pass.
  patchFs(t, 'readdirSync', (original) => (path, ...rest) => {
    if (String(path) === linkPath && (listings += 1) === 3) {
      fs.rmSync(linkPath, { recursive: true });
      writeFileSync(linkPath, 'now a file');
    }
    return original(path, ...rest);
  });
  const r = ensureLink({ linkPath, targetDir, host: 'alpha' });
  assert.deepEqual([r.action, r.reason], ['skipped', 'not-a-directory']);
  assert.equal(readFileSync(linkPath, 'utf8'), 'now a file');
});

test('a folder removed while the first pass lists it gets linked', (t) => {
  const { linkPath, targetDir } = setup(t);
  let listings = 0;
  patchFs(t, 'readdirSync', (original) => (path, ...rest) => {
    if (String(path) === linkPath && (listings += 1) === 3) fs.rmSync(linkPath, { recursive: true });
    return original(path, ...rest);
  });
  const r = ensureLink({ linkPath, targetDir, host: 'alpha' });
  assert.equal(r.action, 'linked');
  assert.ok(lstatSync(linkPath).isSymbolicLink());
});

// Replaces the folder by a file just before the adoption renames it aside.
function replaceBeforeRename(t, linkPath, after) {
  const swap = once(() => {
    fs.rmSync(linkPath, { recursive: true });
    writeFileSync(linkPath, 'someone else file');
  });
  patchFs(t, 'renameSync', (original) => (from, to) => {
    if (from !== linkPath) return original(from, to);
    swap();
    const out = original(from, to);
    after?.();
    return out;
  });
}

test('a file that took the folder path just before the backup is put back', (t) => {
  const { linkPath, targetDir, siblings } = setup(t);
  replaceBeforeRename(t, linkPath);
  const r = ensureLink({ linkPath, targetDir, host: 'alpha' });
  assert.deepEqual([r.action, r.reason, r.backupDir], ['skipped', 'not-a-directory', null]);
  assert.equal(readFileSync(linkPath, 'utf8'), 'someone else file');
  assert.deepEqual(siblings(), ['memory']);
});

test('a file moved aside with the backup stays there when the path is taken again', (t) => {
  const { linkPath, targetDir, siblings } = setup(t);
  replaceBeforeRename(t, linkPath, () => writeFileSync(linkPath, 'newer file'));
  const r = ensureLink({ linkPath, targetDir, host: 'alpha', now: new Date('2026-11-13T07:00:00Z') });
  const backup = join(dirname(linkPath), 'memory.local-backup-20261113T070000Z');
  assert.deepEqual([r.action, r.reason, r.backupDir], ['skipped', 'link-path-taken', backup]);
  assert.equal(readFileSync(backup, 'utf8'), 'someone else file');
  assert.equal(readFileSync(linkPath, 'utf8'), 'newer file');
  assert.deepEqual(siblings(), ['memory', 'memory.local-backup-20261113T070000Z']);
});

test('a note deleted while it is copied is skipped and the rest is adopted', (t) => {
  const { linkPath, targetDir } = setup(t, { 'gone.md': 'bye', 'kept.md': 'stay' });
  patchFs(t, 'copyFileSync', (original) => (from, to) => {
    if (String(from) === join(linkPath, 'gone.md')) fs.rmSync(from);
    return original(from, to);
  });
  const r = ensureLink({ linkPath, targetDir, host: 'alpha' });
  assert.deepEqual([r.action, r.copied], ['adopted', 1]);
  assert.deepEqual(readdirSync(targetDir), ['kept.md']);
  assert.ok(lstatSync(linkPath).isSymbolicLink());
});

test('a note deleted while it is copied beside a different target note is skipped', (t) => {
  const { linkPath, targetDir } = setup(t, { 'note.md': 'local' });
  put(targetDir, 'note.md', 'remote');
  patchFs(t, 'copyFileSync', (original) => (from, to) => {
    if (String(from) === join(linkPath, 'note.md')) fs.rmSync(from);
    return original(from, to);
  });
  const r = ensureLink({ linkPath, targetDir, host: 'alpha' });
  assert.deepEqual([r.action, r.copied, r.renamed], ['adopted', 0, []]);
  assert.deepEqual(readdirSync(targetDir), ['note.md']);
  assert.equal(read(targetDir, 'note.md'), 'remote');
});

test('a note deleted and written again while it is copied is copied on a retry', (t) => {
  const { linkPath, targetDir } = setup(t, { 'note.md': 'v1' });
  let first = true;
  patchFs(t, 'copyFileSync', (original) => (from, to) => {
    if (!first || String(from) !== join(linkPath, 'note.md')) return original(from, to);
    first = false;
    fs.rmSync(from);
    try {
      return original(from, to);
    } finally {
      writeFileSync(from, 'v2');
    }
  });
  const r = ensureLink({ linkPath, targetDir, host: 'alpha' });
  assert.equal(r.action, 'adopted');
  assert.equal(read(targetDir, 'note.md'), 'v2');
  assert.deepEqual(readdirSync(targetDir), ['note.md']);
});

test('a copy that keeps failing with the source present gives up after three tries', (t) => {
  const { linkPath, targetDir } = setup(t, { 'note.md': 'v1' });
  let calls = 0;
  patchFs(t, 'copyFileSync', () => (from) => {
    calls += 1;
    throw Object.assign(new Error(`ENOENT: ${from}`), { code: 'ENOENT' });
  });
  assert.throws(() => ensureLink({ linkPath, targetDir, host: 'alpha' }), { code: 'ENOENT' });
  assert.equal(calls, 3);
  assert.ok(lstatSync(linkPath).isDirectory());
  assert.deepEqual(readdirSync(dirname(linkPath)).filter((n) => n.endsWith('.adopt-lock')), []);
});

test('an index deleted while the first pass reads it is skipped', (t) => {
  const { linkPath, targetDir } = setup(t, { 'note.md': 'hello', 'MEMORY.md': '- [N](note.md)\n' });
  patchFs(t, 'readFileSync', (original) => (path, ...rest) => {
    if (String(path) === join(linkPath, 'MEMORY.md')) fs.rmSync(path);
    return original(path, ...rest);
  });
  const r = ensureLink({ linkPath, targetDir, host: 'alpha' });
  assert.deepEqual([r.action, r.copied], ['adopted', 1]);
  assert.deepEqual(readdirSync(targetDir), ['note.md']);
});

test('a note deleted while the first pass reads it does not make ensureLink throw', (t) => {
  const { linkPath, targetDir } = setup(t, { 'gone.md': 'bye', 'kept.md': 'stay' });
  patchFs(t, 'readFileSync', (original) => (path, ...rest) => {
    if (String(path) === join(linkPath, 'gone.md')) fs.rmSync(path);
    return original(path, ...rest);
  });
  const r = ensureLink({ linkPath, targetDir, host: 'alpha' });
  assert.equal(r.action, 'adopted');
  assert.deepEqual(readdirSync(targetDir), ['kept.md']);
  assert.ok(lstatSync(linkPath).isSymbolicLink());
});

test('a stale adoption lock is removed', (t) => {
  const base = tempDir(t);
  const linkPath = join(base, 'projects', 'p', 'memory');
  const targetDir = join(base, 'clone', 'notes');
  put(linkPath, 'note.md', 'hello');
  const lock = `${linkPath}.adopt-lock`;
  mkdirSync(lock);
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  assert.equal(ensureLink({ linkPath, targetDir, host: 'alpha' }).action, 'adopted');
  assert.deepEqual(readdirSync(dirname(linkPath)).filter((n) => n.includes('.adopt-lock')), []);
});

test('works when the folder name begins with a dash', (t) => {
  const base = tempDir(t);
  const linkPath = join(base, 'projects', '-srv-repos-x', 'memory');
  const targetDir = join(base, 'clone', 'notes');
  assert.equal(ensureLink({ linkPath, targetDir, host: 'alpha' }).action, 'linked');
});

test('adoptDir keeps index links correct when a collision name is also a source file', (t) => {
  const base = tempDir(t);
  const src = join(base, 'src');
  const target = join(base, 'target');
  put(src, 'b.md', 'A');
  put(src, 'b.alpha.md', 'B');
  put(src, 'MEMORY.md', '- [x](b.md)\n- [y](b.alpha.md)\n');
  put(target, 'b.md', 'R');
  const r = adoptDir(src, target, 'alpha');
  assert.deepEqual(r, { copied: 2, renamed: ['b.md -> b.alpha-2.md'] });
  assert.equal(read(target, 'b.md'), 'R');
  assert.equal(read(target, 'b.alpha.md'), 'B');
  assert.equal(read(target, 'b.alpha-2.md'), 'A');
  assert.equal(read(target, 'MEMORY.md'), '- [x](b.alpha-2.md)\n- [y](b.alpha.md)\n');
});

test('mergeIndex rewrites links in one pass', () => {
  const out = mergeIndex('', '- [x](a.md)\n- [y](b.md)\n', new Map([['a.md', 'b.md'], ['b.md', 'c.md']]));
  assert.equal(out, '- [x](b.md)\n- [y](c.md)\n');
});

test('a held lock makes ensureLink give up within the bound and change nothing', (t) => {
  const base = tempDir(t);
  const linkPath = join(base, 'projects', 'p', 'memory');
  const targetDir = join(base, 'clone', 'notes');
  put(linkPath, 'note.md', 'hello');
  const lock = `${linkPath}.adopt-lock`;
  mkdirSync(lock);
  const started = Date.now();
  const r = ensureLink({ linkPath, targetDir, host: 'alpha', lockWaitMs: 200 });
  assert.ok(Date.now() - started < 5000);
  assert.equal(r.action, 'skipped');
  assert.equal(r.reason, 'lock-timeout');
  assert.ok(lstatSync(linkPath).isDirectory());
  assert.equal(read(linkPath, 'note.md'), 'hello');
  assert.deepEqual(readdirSync(targetDir), []);
  assert.ok(lstatSync(lock).isDirectory());
});

test('ensureLink leaves skipped files in the backup and does not copy them', (t) => {
  const base = tempDir(t);
  const linkPath = join(base, 'projects', 'p', 'memory');
  const targetDir = join(base, 'clone', 'notes');
  put(linkPath, 'keep.md', 'K');
  put(linkPath, 'leak.md', 'L');
  const r = ensureLink({
    linkPath, targetDir, host: 'alpha', now: new Date('2026-11-13T07:00:00Z'), skip: new Set(['leak.md']),
  });
  assert.equal(r.action, 'adopted');
  assert.equal(r.copied, 1);
  assert.deepEqual(readdirSync(targetDir), ['keep.md']);
  assert.equal(read(r.backupDir, 'leak.md'), 'L');
  assert.ok(lstatSync(linkPath).isSymbolicLink());
});

// Replaces a node:fs function for the modules under test until the test ends.
function patchFs(t, name, wrap) {
  const original = fs[name];
  fs[name] = wrap(original);
  syncBuiltinESMExports();
  t.after(() => {
    fs[name] = original;
    syncBuiltinESMExports();
  });
}

// Every entry under dir with its kind and content, to show that nothing changed.
function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        out.push(`${p}/`);
        walk(p);
      } else if (e.isSymbolicLink()) out.push(`${p} -> ${fs.readlinkSync(p)}`);
      else out.push(`${p}: ${readFileSync(p, 'utf8')}`);
    }
  };
  walk(dir);
  return out;
}

test('an interrupted copy leaves no note under its final name', (t) => {
  const base = tempDir(t);
  const src = join(base, 'src');
  const target = join(base, 'target');
  put(src, 'a.md', 'the whole note\n');
  put(src, 'MEMORY.md', '- [A](a.md)\n');
  patchFs(t, 'copyFileSync', () => (from, to) => {
    writeFileSync(to, 'the who');
    throw Object.assign(new Error('interrupted'), { code: 'EINTR' });
  });
  assert.throws(() => adoptDir(src, target, 'alpha'), /interrupted/);
  assert.equal(existsSync(join(target, 'a.md')), false);
  assert.deepEqual(readdirSync(target).filter((n) => !/\.tmp\./.test(n)), []);
});

test('an interrupted index write leaves the index as it was', (t) => {
  const base = tempDir(t);
  const src = join(base, 'src');
  const target = join(base, 'target');
  put(src, 'MEMORY.md', '- [B](b.md)\n');
  put(target, 'MEMORY.md', '- [A](a.md)\n');
  patchFs(t, 'renameSync', (original) => (from, to) => {
    if (String(to) === join(target, 'MEMORY.md')) throw Object.assign(new Error('interrupted'), { code: 'EINTR' });
    return original(from, to);
  });
  assert.throws(() => adoptDir(src, target, 'alpha'), /interrupted/);
  assert.equal(read(target, 'MEMORY.md'), '- [A](a.md)\n');
});

test('a note written after the first pass and before the backup reaches the target', (t) => {
  const base = tempDir(t);
  const linkPath = join(base, 'projects', 'p', 'memory');
  const targetDir = join(base, 'clone', 'notes');
  put(linkPath, 'note.md', 'hello');
  patchFs(t, 'renameSync', (original) => (from, to) => {
    if (from === linkPath && String(to).includes('.local-backup-')) writeFileSync(join(linkPath, 'late.md'), 'late\n');
    return original(from, to);
  });
  const r = ensureLink({ linkPath, targetDir, host: 'alpha' });
  assert.deepEqual([r.action, r.copied], ['adopted', 2]);
  assert.equal(read(targetDir, 'late.md'), 'late\n');
  assert.equal(read(r.backupDir, 'late.md'), 'late\n');
  assert.ok(lstatSync(linkPath).isSymbolicLink());
});

test('a memory folder holding a subfolder or a symlink is left exactly as it was', (t) => {
  for (const extra of ['subfolder', 'symlink']) {
    const base = tempDir(t);
    const linkPath = join(base, 'projects', 'p', 'memory');
    const targetDir = join(base, 'clone', 'notes');
    put(linkPath, 'note.md', 'hello');
    if (extra === 'subfolder') put(join(linkPath, 'sub'), 'deep.md', 'deep');
    else symlinkSync(join(linkPath, 'note.md'), join(linkPath, 'alias.md'));
    const before = snapshot(join(base, 'projects'));
    const r = ensureLink({ linkPath, targetDir, host: 'alpha' });
    assert.deepEqual([r.action, r.reason, r.copied, r.backupDir], ['skipped', 'nested-entries', 0, null], extra);
    assert.deepEqual(snapshot(join(base, 'projects')), before, extra);
    assert.deepEqual(readdirSync(targetDir), [], extra);
  }
});

test('a link path taken by something else after the backup is reported, a matching link is not', (t) => {
  for (const [what, action, reason] of [['file', 'skipped', 'link-path-taken'], ['link', 'adopted', null]]) {
    const base = tempDir(t);
    const linkPath = join(base, 'projects', 'p', 'memory');
    const targetDir = join(base, 'clone', 'notes');
    put(linkPath, 'note.md', 'hello');
    const restore = fs.renameSync;
    patchFs(t, 'renameSync', (original) => (from, to) => {
      const out = original(from, to);
      if (from === linkPath) {
        if (what === 'file') writeFileSync(linkPath, 'in the way');
        else symlinkSync(targetDir, linkPath);
      }
      return out;
    });
    const r = ensureLink({ linkPath, targetDir, host: 'alpha', now: new Date('2026-11-13T07:00:00Z') });
    fs.renameSync = restore;
    syncBuiltinESMExports();
    assert.deepEqual([r.action, r.reason], [action, reason], what);
    assert.equal(r.backupDir, join(dirname(linkPath), 'memory.local-backup-20261113T070000Z'));
    assert.equal(read(targetDir, 'note.md'), 'hello');
    assert.equal(read(r.backupDir, 'note.md'), 'hello');
  }
});

test('a stale lock is claimed by one process only', (t) => {
  const base = tempDir(t);
  const linkPath = join(base, 'projects', 'p', 'memory');
  const targetDir = join(base, 'clone', 'notes');
  put(linkPath, 'note.md', 'hello');
  const lock = `${linkPath}.adopt-lock`;
  mkdirSync(lock);
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  let claims = 0;
  patchFs(t, 'renameSync', (original) => (from, to) => {
    if (from !== lock) return original(from, to);
    claims += 1;
    // Another process claims the stale lock first, then takes a fresh one.
    original(from, `${lock}.other-claim`);
    fs.rmSync(`${lock}.other-claim`, { recursive: true });
    try {
      return original(from, to);
    } finally {
      mkdirSync(lock);
    }
  });
  const r = ensureLink({ linkPath, targetDir, host: 'alpha', lockWaitMs: 300 });
  assert.equal(claims, 1);
  assert.deepEqual([r.action, r.reason], ['skipped', 'lock-timeout']);
  assert.ok(lstatSync(linkPath).isDirectory());
  assert.ok(lstatSync(lock).isDirectory());
});
