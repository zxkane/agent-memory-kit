// The agent scopes of the memory API's bucket: `agents/<agent>/<name>.md` notes, each scope's
// MEMORY.md, and the search snapshot `index/agents.json`. The memory API writes them. This module
// lets an Organize run copy one scope into a local folder and write an accepted result back.
//
// Writing back follows the API's own order: the search snapshot first, in one conditional update
// that also checks the API's limits, then the notes, then the scope's MEMORY.md. Every write is
// conditional on the version that was read (or on the key being absent), and every delete on the
// ETag that was copied, so a note that an agent writes through the API meanwhile is never
// overwritten or deleted. Notes are written before any retired note is deleted, and a retired note
// is deleted only while the note it went to holds what this run wrote there: its content always
// lives in at least one object.
//
// Nothing read from the bucket or written by the model reaches a key unchecked: keys are built
// from an agent name and a file name that match the API's rules.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AwsError, assumeRole, environmentCredentials, imdsCredentials } from './aws.mjs';
import { INDEX, parseNote } from './notes.mjs';
import { createS3 } from './s3.mjs';
import { readRegular } from './workdir.mjs';

export const AGENTS_PREFIX = 'agents/';
export const SNAPSHOT_KEY = 'index/agents.json';
// What the runs remember about each agent scope; in the bucket, so that a run in a GitHub Actions
// job, which keeps no state of its own, knows what is already organized.
export const STATE_KEY = 'index/organizer.json';
export const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,196}\.md$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// The memory API's limits (api/src/ops/write.ts and api/src/validate.ts; a test of the API checks
// that both sides agree).
export const API_LIMITS = Object.freeze({
  scopeNotes: 200,
  scopeBytes: 240_000,
  snapshotBytes: 4_000_000,
  contentBytes: 50_000,
  descriptionChars: 300,
  slug: /^[a-z0-9][a-z0-9-]{0,79}$/,
});
const NOTE_TYPES = new Set(['user', 'feedback', 'project', 'reference']);
const LINE_BREAK_RE = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;
// A copied object larger than this is not a note the API wrote: the scope is skipped.
const MAX_OBJECT_BYTES = 1_000_000;
const ATTEMPTS = 5;
const LINK_RE = /\]\(([^()\s]+\.md)\)/;
const MARKDOWN = 'text/markdown; charset=utf-8';
// Credentials are taken again after this long, inside the 15 minutes an assumed role lasts.
const CREDENTIALS_REUSE_MS = 10 * 60 * 1000;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

// `skip`: the scope cannot be organized, the run goes on with the next one.
export class AgentScopeError extends Error {
  constructor(message, { skip = false } = {}) {
    super(message);
    this.skip = skip;
  }
}

// ---- S3 clients ----

// S3 clients for the `agents` part of the consolidate block. Credentials come from the block's one
// source (the environment of a GitHub Actions job, or the instance metadata service), exchanged for
// the role's when `roleArn` is set, and are taken again when they are older than
// CREDENTIALS_REUSE_MS. `signal` stops the client's requests. `deps` replaces the AWS calls in tests.
export function agentScopesS3(block, deps = {}) {
  const fromEnvironment = deps.environmentCredentials ?? environmentCredentials;
  const fromInstance = deps.imdsCredentials ?? imdsCredentials;
  const exchange = deps.assumeRole ?? assumeRole;
  const client = deps.createS3 ?? createS3;
  const clock = deps.clock ?? Date.now;
  let cached = null;
  const credentials = async (signal) => {
    if (cached !== null && clock() - cached.at < CREDENTIALS_REUSE_MS) return cached.credentials;
    const base = block.credentials === 'environment' ? fromEnvironment() : await fromInstance();
    const creds = block.roleArn
      ? await exchange({ roleArn: block.roleArn, sessionName: 'agent-memory-organizer', region: block.region, credentials: base, signal })
      : base;
    cached = { credentials: creds, at: clock() };
    return creds;
  };
  return async ({ signal } = {}) => client({ bucket: block.bucket, region: block.region, credentials: await credentials(signal), signal });
}

// ---- Reading the bucket ----

// agent -> [{ file, etag, size }] for every key `agents/<agent>/<file>.md` that the API's rules
// allow; any other key under agents/ is left alone.
export async function listAgentScopes(s3) {
  const scopes = new Map();
  for (const { key, etag, size } of await s3.list(AGENTS_PREFIX, { maxKeys: 5000 })) {
    const parts = key.slice(AGENTS_PREFIX.length).split('/');
    if (parts.length !== 2 || !AGENT_RE.test(parts[0]) || !FILE_RE.test(parts[1])) continue;
    if (!scopes.has(parts[0])) scopes.set(parts[0], []);
    scopes.get(parts[0]).push({ file: parts[1], etag, size });
  }
  for (const files of scopes.values()) files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return scopes;
}

const scopeEtags = async (s3, agent) => new Map(((await listAgentScopes(s3)).get(agent) ?? []).map((f) => [f.file, f.etag]));

// SHA-256 over the sorted `file:etag` lines of a scope: it changes whenever a note does.
export const scopeDigest = (files) => sha256(files.map((f) => `${f.file}:${f.etag}`).sort().join('\n'));

// The notes of a scope, MEMORY.md not counted.
export const noteCount = (files) => files.filter((f) => f.file !== INDEX).length;

// The text and ETag of an object, or null when it is missing. A role that may not list the key's
// folder is told "access denied" for a missing key, which counts as missing.
async function readText(s3, key) {
  const res = await s3.get(key, { deniedIsMissing: true, maxBytes: 8 * 1024 * 1024 });
  return res.status === 'ok' ? { text: res.body.toString('utf8'), etag: res.etag } : null;
}

// A path that the API's parseNotePath accepts: `<scope>/<file>.md`, the scope being `global`,
// `projects/<project>` or `agents/<agent>`.
export function isNotePath(path) {
  if (typeof path !== 'string') return false;
  const cut = path.lastIndexOf('/');
  if (cut < 0 || !FILE_RE.test(path.slice(cut + 1))) return false;
  const scope = path.slice(0, cut);
  if (scope === 'global') return true;
  const parts = scope.split('/');
  return parts.length === 2 && ((parts[0] === 'projects' && PROJECT_RE.test(parts[1])) || (parts[0] === 'agents' && AGENT_RE.test(parts[1])));
}

// The search snapshot as the API reads it: `{ doc, notes, others }`. `notes` are the well-formed
// note entries, `others` every other entry, kept as they are, after the notes. Text that is not a
// snapshot throws: a write must never replace what it cannot read.
function parseSnapshot(text) {
  if (text === null) return { doc: { version: 1, notes: [] }, notes: [], others: [] };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new AgentScopeError('the search snapshot of the agent scopes is unreadable');
  }
  if (!isObject(doc) || !Array.isArray(doc.notes)) throw new AgentScopeError('the search snapshot of the agent scopes is unreadable');
  const isNote = (e) => isObject(e) && ['path', 'name', 'description', 'type', 'body'].every((k) => typeof e[k] === 'string') && isNotePath(e.path);
  return {
    doc,
    notes: doc.notes.filter(isNote).map(({ path, name, description, type, body }) => ({ path, name, description, type, body })),
    others: doc.notes.filter((e) => !isNote(e)),
  };
}

const serialize = (parsed, notes) => JSON.stringify({ ...parsed.doc, version: 1, notes: [...[...notes].sort(byPath), ...parsed.others] });
const scopeOf = (agent) => `${AGENTS_PREFIX}${agent}/`;
const entriesOf = (notes, agent) => notes.filter((n) => n.path.startsWith(scopeOf(agent))).sort(byPath);

// ---- Note files and their search entries ----

// The frontmatter's description as the API wrote it (a JSON string), or as written by hand.
function descriptionOf(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  const line = lines.slice(1, end < 0 ? 1 : end).find((l) => l.startsWith('description:'));
  if (line === undefined) return null;
  const raw = line.slice('description:'.length).trim();
  if (raw.startsWith('"')) {
    try {
      const value = JSON.parse(raw);
      if (typeof value === 'string') return value;
    } catch {
      // Not JSON: read as plain text below.
    }
  }
  return parseNote(text).description;
}

// The text after the frontmatter block, without the blank lines around it.
function bodyOf(text) {
  const lines = String(text).split(/\r?\n/);
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  return (end < 0 ? lines : lines.slice(end + 1)).join('\n').replace(/^\n+/, '').trimEnd();
}

// The search snapshot entry of a note file, as the API would write it.
export function noteEntry(agent, file, text) {
  return {
    path: `${scopeOf(agent)}${file}`,
    name: file.slice(0, -'.md'.length),
    description: (descriptionOf(text) ?? '').trim(),
    type: parseNote(text).type ?? '',
    body: bodyOf(text),
  };
}

// Two lists of entries describe the same notes, line ends and surrounding blank lines aside (the
// API keeps the text as it was sent; its note file holds it trimmed).
function sameEntries(a, b) {
  const norm = (e) => ({ ...e, description: e.description.trim(), body: e.body.replace(/\r\n?/g, '\n').replace(/^\n+/, '').trimEnd() });
  const list = (entries) => JSON.stringify(entries.map(norm).sort(byPath));
  return list(a) === list(b);
}

// ---- Copying a scope ----

// Copies the notes of `agent` into `dir` (an empty folder) and returns what applying checks
// against: each copied object's ETag, the scope's entries of the search snapshot, the snapshot's
// size, and `inStep`: whether those entries describe the copied notes. They do not after a write
// that stopped part-way; an applied run then rewrites them from the notes.
export async function copyAgentScope({ s3, agent, dir }) {
  if (!AGENT_RE.test(agent)) throw new AgentScopeError('invalid agent name');
  const files = (await listAgentScopes(s3)).get(agent) ?? [];
  const tooLarge = () => new AgentScopeError(`a note of this scope is larger than ${MAX_OBJECT_BYTES} bytes`, { skip: true });
  if (files.some((f) => f.size > MAX_OBJECT_BYTES)) throw tooLarge();
  const etags = {};
  for (const { file } of files) {
    let res;
    try {
      res = await s3.get(`${scopeOf(agent)}${file}`, { maxBytes: MAX_OBJECT_BYTES });
    } catch (err) {
      if (err instanceof AwsError && err.code === 'TooLarge') throw tooLarge();
      throw err;
    }
    if (res.status !== 'ok') continue; // deleted since the listing: not part of the copy
    writeFileSync(join(dir, file), res.body, { mode: 0o600, flag: 'wx' });
    etags[file] = res.etag;
  }
  const snapshot = await readText(s3, SNAPSHOT_KEY);
  const entries = entriesOf(parseSnapshot(snapshot?.text ?? null).notes, agent);
  const fromFiles = Object.keys(etags).filter((f) => f !== INDEX).map((f) => noteEntry(agent, f, readFileSync(join(dir, f), 'utf8')));
  return { agent, etags, entries, snapshotBytes: snapshot ? bytes(snapshot.text) : 0, inStep: sameEntries(entries, fromFiles) };
}

// ---- Rules of the memory API ----

// Problems with a note the memory API could not have written: the result is rejected with them.
function noteProblems(file, text, isNew) {
  const at = `notes/${file}`;
  const problems = [];
  const stem = file.slice(0, -'.md'.length);
  if (isNew && (!API_LIMITS.slug.test(stem) || stem === 'memory')) {
    problems.push(`${at}: a new note in an agent scope needs a file name of lower-case letters, digits and hyphens (at most 80, not "memory")`);
  }
  const description = descriptionOf(text);
  if (description === null || LINE_BREAK_RE.test(description) || description.trim() === '' || description.trim().length > API_LIMITS.descriptionChars) {
    problems.push(`${at}: the frontmatter needs a description of one line, 1 to ${API_LIMITS.descriptionChars} characters`);
  }
  if (!NOTE_TYPES.has(parseNote(text).type)) {
    problems.push(`${at}: the frontmatter needs metadata.type user, feedback, project or reference`);
  }
  const body = bodyOf(text);
  if (body === '' || bytes(body) > API_LIMITS.contentBytes) {
    problems.push(`${at}: the note text after the frontmatter must be 1 to ${API_LIMITS.contentBytes} bytes`);
  }
  return problems;
}

// The new text of every changed or added file (MEMORY.md included), read once and checked against
// the hash that evaluate took of it; a file that is not the one checked is a problem.
function resultBodies(changes, workDir) {
  const bodies = new Map();
  const problems = [];
  for (const c of changes) {
    if (c.kind === 'retire') continue;
    const buf = readRegular(join(workDir, c.file));
    if (buf && sha256(buf) === c.hash) bodies.set(c.file, buf);
    else problems.push(`notes/${c.file}: the file changed after it was checked`);
  }
  return { bodies, problems };
}

// The scope's search entries after an accepted result: one for every note of the result (copied or
// added, and not retired), from its new text or, for a note the result leaves alone, from the copy.
function resultEntries({ agent, plan, changes, bodies, liveDir }) {
  const retired = new Set(changes.filter((c) => c.kind === 'retire').map((c) => c.file));
  const entries = [];
  for (const file of new Set([...Object.keys(plan.etags), ...bodies.keys()])) {
    if (file === INDEX || retired.has(file)) continue;
    const buf = bodies.get(file) ?? readRegular(join(liveDir, file));
    if (buf) entries.push(noteEntry(agent, file, buf.toString('utf8')));
  }
  return entries.sort(byPath);
}

const limitProblems = (entries, otherBytes) => {
  const problems = [];
  if (entries.length > API_LIMITS.scopeNotes) problems.push(`the scope would hold ${entries.length} notes; the memory API allows ${API_LIMITS.scopeNotes}`);
  if (bytes(JSON.stringify(entries)) > API_LIMITS.scopeBytes) problems.push(`the scope's notes would take more than the ${API_LIMITS.scopeBytes} bytes the memory API allows`);
  if (otherBytes !== null && otherBytes + bytes(JSON.stringify(entries)) > API_LIMITS.snapshotBytes) {
    problems.push(`the search snapshot would grow past the ${API_LIMITS.snapshotBytes} bytes the memory API allows`);
  }
  return problems;
};

// The rules an agent scope adds to Organize's: every changed or added note must be one the memory
// API could have written (name, frontmatter, size), and the scope must stay within its limits.
export function agentScopeProblems({ agent, plan, changes, liveDir, workDir }) {
  const { bodies, problems } = resultBodies(changes, workDir);
  for (const c of changes) {
    if (c.file === INDEX || c.kind === 'retire' || !bodies.has(c.file)) continue;
    problems.push(...noteProblems(c.file, bodies.get(c.file).toString('utf8'), c.kind === 'add'));
  }
  const before = bytes(JSON.stringify(plan.entries));
  problems.push(...limitProblems(resultEntries({ agent, plan, changes, bodies, liveDir }), Math.max(0, plan.snapshotBytes - before)));
  return problems;
}

// ---- Writing back ----

// One conditional read-modify-write of `key`. `change(text | null)` returns the new text, or
// throws to write nothing. A write that loses a race reads again, up to ATTEMPTS times. Returns
// the ETag of the object written.
async function updateObject(s3, key, change, contentType) {
  for (let i = 0; i < ATTEMPTS; i++) {
    const current = await readText(s3, key);
    const next = change(current?.text ?? null);
    const put = await s3.put(key, next, { contentType, ...(current ? { ifMatch: current.etag } : { ifNoneMatch: '*' }) });
    if (put.status === 'ok') return put.etag;
  }
  throw new AgentScopeError(`${key} was changed concurrently on every attempt`);
}

// Index lines of `current` that are not in `base` were written by the API meanwhile; each replaces
// the line of `result` that links the same note, or is added at the end. A note of `keep` (one the
// run meant to retire and that is still in the bucket) keeps a line: its line in `current`, else
// in `base`.
export function mergeIndex(result, base, current, keep = []) {
  const lines = (text) => (text ? text.replace(/\n$/, '').split('\n') : []);
  const linked = (line) => LINK_RE.exec(line)?.[1];
  const baseLines = new Set(lines(base));
  const out = lines(result);
  const put = (line) => {
    const file = linked(line);
    const at = file === undefined ? -1 : out.findIndex((l) => linked(l) === file);
    if (at >= 0) out[at] = line;
    else out.push(line);
  };
  for (const line of lines(current).filter((l) => !baseLines.has(l))) put(line);
  for (const file of keep) {
    if (out.some((l) => linked(l) === file)) continue;
    const line = lines(current).find((l) => linked(l) === file) ?? lines(base).find((l) => linked(l) === file);
    if (line !== undefined) out.push(line);
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

class Meanwhile extends Error {}

// Writes an accepted result of `agent` back to the bucket. `plan` is what copyAgentScope returned,
// `changes` evaluate's changes (none rewrites the search entries alone, for a scope whose entries
// are out of step), `liveDir` the copy as it was taken, `workDir` the result.
// Returns `{ outcome: 'applied', written, deleted, keptNewer, kept, digest }`, or
// `{ outcome: 'changed-meanwhile', liveChanged }` / `{ outcome: 'rejected', errors }` with nothing
// written. `keptNewer` names the notes an agent wrote again after the search snapshot was updated
// (its version stays), `kept` the retired notes that stay because the note they went to does not
// hold what this run wrote, and `digest` is the scope's digest as this run left it. An error after
// the snapshot update is thrown with `partial` set.
export async function applyAgentScope({ s3, agent, plan, changes, liveDir, workDir }) {
  if (!AGENT_RE.test(agent)) throw new AgentScopeError('invalid agent name');
  // Every text this run writes is read once, here, and must be the one the rules checked.
  const { bodies, problems } = resultBodies(changes, workDir);
  if (problems.length > 0) return { outcome: 'rejected', errors: problems };
  // 1. The scope must still hold exactly what was copied.
  const now = await scopeEtags(s3, agent);
  const names = new Set([...Object.keys(plan.etags), ...now.keys()]);
  const moved = [...names].filter((file) => plan.etags[file] !== now.get(file)).sort();
  if (moved.length > 0) return { outcome: 'changed-meanwhile', liveChanged: moved };

  // 2. The search snapshot, in one conditional update. After it the result counts as applied.
  const entries = resultEntries({ agent, plan, changes, bodies, liveDir });
  let refused = null;
  try {
    await updateObject(s3, SNAPSHOT_KEY, (text) => {
      const parsed = parseSnapshot(text);
      if (JSON.stringify(entriesOf(parsed.notes, agent)) !== JSON.stringify(plan.entries)) throw new Meanwhile();
      const next = serialize(parsed, [...parsed.notes.filter((n) => !n.path.startsWith(scopeOf(agent))), ...entries]);
      const problems = limitProblems(entries, null);
      if (bytes(next) > API_LIMITS.snapshotBytes) problems.push(`the search snapshot would grow past the ${API_LIMITS.snapshotBytes} bytes the memory API allows`);
      if (problems.length > 0) {
        refused = problems;
        throw new Meanwhile();
      }
      return next;
    }, 'application/json');
  } catch (err) {
    if (!(err instanceof Meanwhile)) throw err;
    return refused ? { outcome: 'rejected', errors: refused } : { outcome: 'changed-meanwhile', liveChanged: [SNAPSHOT_KEY] };
  }

  try {
    return await writeResult({ s3, agent, plan, changes, bodies, liveDir });
  } catch (err) {
    // The snapshot is already updated: part of the result may be in the bucket.
    const partial = err instanceof Error ? err : new AgentScopeError(String(err));
    partial.partial = true;
    throw partial;
  }
}

// When the scope's search entries do not describe the copied notes, rewrites them from the copy,
// with no other write: for a result that was not applied (a rejected one). Returns true when it did.
export async function repairAgentEntries({ s3, agent, plan, liveDir }) {
  if (plan.inStep) return false;
  const res = await applyAgentScope({ s3, agent, plan, changes: [], liveDir, workDir: liveDir });
  return res.outcome === 'applied';
}

// The search entries of `files`, read back from their objects: a note that is gone loses its entry.
async function refreshEntries(s3, agent, files) {
  const fresh = new Map();
  for (const file of files) {
    const res = await s3.get(`${scopeOf(agent)}${file}`, { maxBytes: MAX_OBJECT_BYTES });
    fresh.set(`${scopeOf(agent)}${file}`, res.status === 'ok' ? noteEntry(agent, file, res.body.toString('utf8')) : null);
  }
  await updateObject(s3, SNAPSHOT_KEY, (text) => {
    const parsed = parseSnapshot(text);
    const others = parsed.notes.filter((n) => !fresh.has(n.path));
    return serialize(parsed, [...others, ...[...fresh.values()].filter((e) => e !== null)]);
  }, 'application/json');
}

// Steps 3 to 5 of applyAgentScope, after the search snapshot was updated.
async function writeResult({ s3, agent, plan, changes, bodies, liveDir }) {
  const scope = scopeOf(agent);
  // file -> the ETag this run leaves it with; null when an agent's newer version stayed instead.
  const after = new Map(Object.entries(plan.etags));
  const keptNewer = [];
  const kept = [];
  let written = 0;
  let deleted = 0;

  // 3. The notes, before any delete: a changed one only over the copied version, an added one only
  // where none exists.
  for (const c of changes) {
    if (c.file === INDEX || c.kind === 'retire') continue;
    const cond = c.kind === 'add' ? { ifNoneMatch: '*' } : { ifMatch: plan.etags[c.file] };
    const res = await s3.put(`${scope}${c.file}`, bodies.get(c.file), { contentType: MARKDOWN, ...cond });
    if (res.status === 'ok') {
      written++;
      after.set(c.file, res.etag);
    } else {
      keptNewer.push(c.file);
      after.set(c.file, null);
    }
  }

  // 4. Retired notes: each only in the copied version, and only while the note it went to holds
  // what this run left there (a target an agent wrote again, or that this run could not write,
  // may not hold the retired note's content).
  const retires = changes.filter((c) => c.kind === 'retire');
  if (retires.length > 0) {
    const live = await scopeEtags(s3, agent);
    for (const c of retires) {
      const target = c.target?.label === 'notes' ? c.target.file : null;
      const want = target === null ? null : (after.get(target) ?? null);
      if (want === null || live.get(target) !== want) {
        kept.push(c.file);
        continue;
      }
      const res = await s3.del(`${scope}${c.file}`, { ifMatch: plan.etags[c.file] });
      if (res.status === 'conflict') {
        keptNewer.push(c.file);
        after.set(c.file, null);
      } else {
        if (res.status === 'ok') deleted++;
        after.delete(c.file);
      }
    }
  }

  // Notes that stay against the result get their search entries from what the bucket holds.
  if (keptNewer.length > 0 || kept.length > 0) await refreshEntries(s3, agent, [...keptNewer, ...kept]);

  // 5. The index: the result's MEMORY.md, the lines the API wrote meanwhile, and a line for every
  // retired note that is still in the bucket (kept, or written again since it was deleted).
  const retiredFiles = new Set(retires.map((c) => c.file));
  const present = retiredFiles.size === 0 ? [] : [...(await scopeEtags(s3, agent)).keys()].filter((f) => retiredFiles.has(f)).sort();
  if (changes.some((c) => c.file === INDEX) || present.length > 0) {
    const base = readRegular(join(liveDir, INDEX))?.toString('utf8') ?? '';
    const result = bodies.get(INDEX)?.toString('utf8') ?? base;
    after.set(INDEX, await updateObject(s3, `${scope}${INDEX}`, (current) => mergeIndex(result, base, current ?? '', present), MARKDOWN));
    written++;
  }

  const digest = scopeDigest([...after].filter(([, etag]) => etag !== null).map(([file, etag]) => ({ file, etag })));
  return { outcome: 'applied', written, deleted, keptNewer: keptNewer.sort(), kept: kept.sort(), digest };
}

// ---- What the runs remember: index/organizer.json ----

// `{ version: 1, scopes: { <agent>: { ... } } }`; a missing or unreadable object is an empty state
// (an unreadable one is replaced at the next record).
export async function readOrganizerState(s3) {
  const found = await readText(s3, STATE_KEY);
  return parseState(found?.text ?? null);
}

function parseState(text) {
  let doc = null;
  try {
    doc = text === null ? null : JSON.parse(text);
  } catch {
    doc = null;
  }
  const scopes = Object.create(null);
  if (isObject(doc) && isObject(doc.scopes)) {
    for (const [agent, entry] of Object.entries(doc.scopes)) if (AGENT_RE.test(agent) && isObject(entry)) scopes[agent] = { ...entry };
  }
  return { version: 1, scopes };
}

// Replaces the entry of `agent` with `change(entry)`, in one conditional update.
export async function recordOrganizerState(s3, agent, change) {
  if (!AGENT_RE.test(agent)) throw new AgentScopeError('invalid agent name');
  await updateObject(s3, STATE_KEY, (text) => {
    const state = parseState(text);
    state.scopes[agent] = change({ ...(state.scopes[agent] ?? {}) });
    return `${JSON.stringify(state, null, 2)}\n`;
  }, 'application/json');
}
