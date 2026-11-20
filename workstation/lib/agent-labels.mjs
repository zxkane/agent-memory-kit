// The label step over the agent scopes of the memory API's bucket (`label --agents`, and the end of
// every `organize --agents` run), with the decisions of label-run.mjs and each object's ETag as the
// digest of its note. It lists the bucket once and reads the notes it needs: on a scope's first run
// every note, to see which carry a label; on later runs the touched ones (no record entry, or
// another ETag) and those with an exception. It asks the model in batches, then, scope by scope,
// writes each changed label over the version it listed and read (If-Match: an agent's write
// meanwhile wins), gives the written notes their search entries (setNoteEntries), and records what
// it saw in the scope's entry of index/organizer.json (`labels`: file -> ETag, `lastLabel`), where
// Organize's record moves with the labels. A label that would take a scope past what the memory
// API accepts is not written. A dry run writes nothing. Its lines hold names, labels, counts and
// fixed reasons: never a note's text, the model's reasons, a response body or the token.

import {
  API_LIMITS, AgentScopeError, FILE_RE, MARKDOWN, MAX_OBJECT_BYTES, listAgentScopes, noteEntry, readOrganizerState,
  readSearchEntries, recordOrganizerState, scopeDigest, setNoteEntries,
} from './agent-scopes.mjs';
import { AwsError } from './aws.mjs';
import { readDomain, setDomain } from './domains.mjs';
import { labelBatch as modelBatch } from './label-client.mjs';
import { isLabelNoteName, labelNoteOf } from './label-notes.mjs';
import { askLabelModel, labelReport, labelResults, nextLabelRecord, planLabelBatches, selectTouched } from './label-run.mjs';

const bytes = (text) => Buffer.byteLength(text, 'utf8');
// What an error may print: an AWS or agent-scope error's own fixed message, anything else one line.
const errorText = (err) => (err instanceof AwsError || err instanceof AgentScopeError
  ? err.message : String(err?.message ?? err).split('\n')[0] || 'failed');

// Why a note the pass took was not labeled; it stays touched.
const LEFT = {
  meanwhile: 'not written; an agent wrote it meanwhile',
  large: `not read; larger than ${MAX_OBJECT_BYTES} bytes`,
  content: `not written; its text after the frontmatter is over the ${API_LIMITS.contentBytes} bytes the memory API allows`,
  scope: `not written; the scope's search entries would take more than the ${API_LIMITS.scopeBytes} bytes the memory API allows`,
  failed: 'not written; a write to the bucket failed',
};

// A scope's record (`labels` of its entry in index/organizer.json, file -> ETag) by note path, or
// null when it has none: the scope's first run.
function recordOf(scope, entry) {
  const labels = entry?.labels;
  if (labels === null || typeof labels !== 'object' || Array.isArray(labels)) return null;
  return Object.fromEntries(Object.entries(labels).filter(([file, etag]) => FILE_RE.test(file) && typeof etag === 'string')
    .map(([file, etag]) => [`${scope}/${file}`, etag]));
}

// What the pass reads of one scope from its listing `files` (sorted by name): every note when the
// scope has no record or with `all`, otherwise the notes whose ETag is not the one recorded and
// those with an exception. A note is read in the version listed only: one that changed since (an
// agent wrote it) waits for the next run. `read`: the notes as labelNoteOf gives them, with
// `digest` (the ETag) and `text`; `present`: the paths of all the scope's notes; `left`: the notes
// not read, with why.
async function readScope({ s3, scope, files, record, all, domains }) {
  const out = { read: [], present: [], left: new Map() };
  for (const f of files) {
    if (!isLabelNoteName(f.file)) continue;
    const path = `${scope}/${f.file}`;
    const recorded = record !== null && Object.hasOwn(record, path) && record[path] === f.etag;
    if (recorded && !all && !domains.exceptions.has(path)) {
      out.present.push(path);
      continue;
    }
    const res = f.size > MAX_OBJECT_BYTES ? null : await getNote(s3, path);
    // Deleted since the listing.
    if (res?.status === 'missing') continue;
    if (res === null || res.etag !== f.etag) {
      out.present.push(path);
      out.left.set(path, res === null ? LEFT.large : LEFT.meanwhile);
      continue;
    }
    const note = labelNoteOf(scope, f.file, res.body);
    // A retired note (a MOVED TO stub) is not one the step labels.
    if (note === null) continue;
    out.present.push(path);
    out.read.push({ ...note, digest: f.etag, text: res.body.toString('utf8') });
  }
  return out;
}

// An object of at most MAX_OBJECT_BYTES as s3.get gives it, or null when it is larger.
async function getNote(s3, key) {
  try {
    return await s3.get(key, { maxBytes: MAX_OBJECT_BYTES });
  } catch (err) {
    if (err instanceof AwsError && err.code === 'TooLarge') return null;
    throw err;
  }
}

// Writes the labels `planned` gives the notes of scope `s`, each only while it fits what the memory
// API accepts, then the written notes' search entries, then the scope's record, where Organize's
// record moves to the listing the pass read with its own writes, if it was that listing. `entries`:
// the search entries as read before the writes. In a dry run, only what would be written.
async function writeScope({ s3, s, planned, entries, started, dryRun }) {
  const out = { written: [], unchanged: [], left: new Map(), notWritten: 0, details: [], failed: false };
  // The scope's entries as the memory API counts them against its limit (api/src/ops/write.ts).
  const scopeEntries = new Map(entries.filter((e) => e.path.startsWith(`${s.scope}/`)).map((e) => [e.path, e]));
  const fits = (next) => bytes(JSON.stringify([...next.values()])) <= API_LIMITS.scopeBytes;
  const skip = (path, why) => {
    out.left.set(path, why);
    out.notWritten += 1;
  };
  let client = null;
  let broken = null;
  for (const n of s.editable) {
    const p = planned.get(n.path);
    if (p === undefined) continue;
    if (readDomain(n.text) === p.label) {
      out.unchanged.push({ path: n.path, digest: n.digest });
      continue;
    }
    const text = setDomain(n.text, p.label).text;
    const entry = noteEntry(s.agent, n.file, text);
    if (bytes(entry.body) > API_LIMITS.contentBytes) {
      skip(n.path, LEFT.content);
      continue;
    }
    const next = new Map(scopeEntries).set(n.path, entry);
    if (!fits(next)) {
      skip(n.path, LEFT.scope);
      continue;
    }
    if (dryRun) {
      out.written.push({ path: n.path, file: n.file, text, etag: null });
      scopeEntries.set(n.path, entry);
      continue;
    }
    if (broken !== null) {
      skip(n.path, LEFT.failed);
      continue;
    }
    let put = null;
    try {
      client ??= await s3();
      put = await client.put(n.path, text, { ifMatch: n.digest, contentType: MARKDOWN });
    } catch (err) {
      broken = errorText(err);
      skip(n.path, LEFT.failed);
      continue;
    }
    if (put.status !== 'ok') {
      skip(n.path, LEFT.meanwhile);
      continue;
    }
    out.written.push({ path: n.path, file: n.file, text, etag: put.etag });
    scopeEntries.set(n.path, entry);
  }
  if (dryRun) return out;
  if (broken !== null) {
    out.failed = true;
    out.details.push(`  - a write to the bucket failed (${broken}); the scope's other labels are left for the next run`);
  }
  try {
    client ??= await s3();
    let entriesWritten = true;
    if (out.written.length > 0) {
      try {
        await setNoteEntries(client, s.agent, out.written.map((w) => ({ file: w.file, text: w.text })));
      } catch (err) {
        entriesWritten = false;
        out.failed = true;
        out.details.push(`  - the search entries of the scope could not be updated (${errorText(err)});`
          + ' it stays due for Organize, which rewrites them');
      }
    }
    const kept = new Set([...out.written, ...out.unchanged].map((x) => x.path));
    const record = nextLabelRecord(s.record, {
      present: s.present, written: out.written.map((w) => ({ path: w.path, digest: w.etag })), unchanged: out.unchanged,
      confirmed: s.confirmed, left: s.touched.map((n) => n.path).filter((path) => !kept.has(path)),
    });
    const etags = new Map(out.written.map((w) => [w.file, w.etag]));
    const before = scopeDigest(s.files);
    const after = scopeDigest(s.files.map((f) => (etags.has(f.file) ? { file: f.file, etag: etags.get(f.file) } : f)));
    await recordOrganizerState(client, s.agent, (entry) => {
      entry.labels = Object.fromEntries(Object.entries(record).map(([path, etag]) => [path.slice(s.scope.length + 1), etag]));
      entry.lastLabel = started.toISOString();
      // Labels never make a scope due: Organize's record moves with them where it was the
      // content the pass listed. A scope that was due stays due, and so does one an agent wrote
      // into meanwhile, or whose entries could not be updated (Organize then rewrites them).
      if (entriesWritten && entry.organizedDigest === before) entry.organizedDigest = after;
      return entry;
    });
  } catch (err) {
    out.failed = true;
    out.details.push(`  - the run could not be recorded in index/organizer.json: ${errorText(err)}`);
  }
  return out;
}

// The line of a scope. `idle`: nothing of it was touched or left; `took`: a label was planned for it.
function headline(s, out, { dryRun, idle, took }) {
  const scope = `label ${s.scope}`;
  const written = out.written.length;
  if (idle) return `${scope}: nothing to do`;
  if (dryRun) return `${scope}: dry-run, ${written} label(s) to set or change`;
  if (!took) return `${scope}: nothing written`;
  const notWritten = out.notWritten > 0 ? `, ${out.notWritten} not written` : '';
  return `${scope}: ${written > 0 ? 'applied' : 'no-change'}, ${written} label(s) written, ${out.unchanged.length} unchanged${notWritten}`;
}

// The label pass over the agent scopes of the bucket (every scope, or `opts.agentNames`). `s3` gives
// the S3 client (agentScopesS3: reads get `signal`, writes do not, so that once they started they
// finish), `token()` the run's one token as `{ token, tokenAt }`, asked for only when there is a
// batch to send, `labelBatch` the model call (label-client's), `domains` and `persona` the label
// inputs. The ceiling is `maxBudgetUsd`, for this pass's own model cost. `failed`: the bucket
// could not be read, no token could be made, a batch failed, or a write failed. A signal before
// the writes stops it with nothing written; one later stops it before the next scope's writes.
// Returns the lines to print: one per scope, then the report without the model's reasons.
export async function labelAgentScopes({ config, opts, s3, started, domains, persona, token, labelBatch = modelBatch, signal }) {
  const c = config.consolidate;
  const lines = [];
  const scopes = [];
  try {
    const client = await s3({ signal });
    const listing = await listAgentScopes(client);
    const state = await readOrganizerState(client);
    const agents = (opts.agentNames.length > 0 ? opts.agentNames : [...listing.keys()]).filter((agent) => listing.has(agent));
    for (const agent of agents) {
      const scope = `agents/${agent}`;
      const files = listing.get(agent);
      const record = recordOf(scope, state.scopes[agent]);
      scopes.push({ agent, scope, files, record, ...(await readScope({ s3: client, scope, files, record, all: opts.all, domains })) });
    }
  } catch (err) {
    if (signal?.aborted) return { failed: false, lines };
    return { failed: true, lines: [`label: the agent scopes could not be read (${errorText(err)}); no label was written.`] };
  }
  if (scopes.length === 0) return { failed: false, lines: ['label: nothing to do'] };

  // Only notes whose frontmatter the pass can edit go to the model or take an exception.
  for (const s of scopes) {
    s.editable = s.read.filter((n) => n.skip === null);
    Object.assign(s, selectTouched({ notes: s.editable, record: s.record, all: opts.all }));
  }
  const { exceptions, batches } = planLabelBatches({
    notes: scopes.flatMap((s) => s.editable), touched: scopes.flatMap((s) => s.touched), domains, batchNotes: c.label.batchNotes,
  });
  const asked = await askLabelModel({
    batches, token, ceiling: c.maxBudgetUsd, now: () => Date.now(), signal,
    labelBatch: (notes, runToken) => labelBatch({ notes, persona, label: c.label, token: runToken, signal }),
  });
  if (asked.line) lines.push(asked.line);
  // Interrupted: nothing is written, and every note stays as it is.
  if (asked.stop === 'interrupted' || signal?.aborted) return { failed: asked.failed, lines };
  if (asked.sent > 0) lines.push(`label: ${asked.sent} note(s) sent to the model, USD ${asked.spent.toFixed(2)}, ${asked.requests} request(s)`);
  let failed = asked.failed;
  const planned = new Map([
    ...exceptions.map((e) => [e.path, { label: e.label, reason: null, exception: true }]),
    ...[...asked.labels].map(([path, given]) => [path, { ...given, exception: false }]),
  ]);

  let entries;
  try {
    entries = await readSearchEntries(await s3({ signal }));
  } catch (err) {
    if (signal?.aborted) return { failed, lines };
    lines.push(`label: the search entries of the agent scopes could not be read (${errorText(err)}); no label was written.`);
    return { failed: true, lines };
  }
  const domainOf = new Map(entries.map((e) => [e.path, e.domain ?? null]));
  const results = [];
  for (const s of scopes) {
    if (signal?.aborted) break;
    const out = await writeScope({ s3, s, planned, entries, started, dryRun: opts.dryRun });
    failed ||= out.failed;
    const mine = (path) => path.startsWith(`${s.scope}/`);
    const took = [...planned.keys()].some(mine);
    const idle = !took && s.touched.length === 0 && s.left.size === 0;
    lines.push(headline(s, out, { dryRun: opts.dryRun, idle, took }), ...out.details);
    // The notes the pass did not read count with the label of their search entry.
    const read = new Set(s.read.map((n) => n.path));
    const notes = [
      ...s.read,
      ...s.present.filter((path) => !read.has(path)).map((path) => ({ path, scope: s.scope, domain: domainOf.get(path) ?? null, skip: null })),
    ];
    results.push(labelResults({
      scopes: [s.scope], notes, exceptions: domains.exceptions,
      planned: new Map([...out.written, ...out.unchanged].map((x) => [x.path, planned.get(x.path)])),
      left: new Map([...[...asked.left].filter(([path]) => mine(path)), ...s.left, ...out.left]),
    })[0]);
  }
  const report = labelReport(results, { reasons: false });
  if (report !== '') lines.push(...report.trimEnd().split('\n'));
  return { failed, lines };
}
