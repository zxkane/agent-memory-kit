// The label step over the agent scopes of the memory API's bucket (`label --agents`, and the end of
// every `organize --agents` run), with the decisions of label-run.mjs and each object's ETag as the
// digest of its note. It lists the bucket once, reads the search entries before the model calls and
// again before the writes, and reads the notes it needs: on a scope's first run every note, to see
// which carry a label; on later runs the touched ones (no record entry, or another ETag), those
// with an exception, and those whose search entry carries no label. It asks the model in batches,
// except for a note that no label would let fit what the memory API accepts, then, scope by scope,
// writes each changed label over the version it listed and read (If-Match: an agent's write
// meanwhile wins), gives the written notes their search entries, and the notes it read whose entry
// lacks their label that label, in one update (setNoteEntries), and records what it saw in the
// scope's entry of index/organizer.json (`labels`: file -> ETag, `lastLabel`), where Organize's
// record moves with the labels. A label that would take a scope past what the memory API accepts
// is not written. A dry run writes nothing. Its lines hold names, labels, counts and fixed reasons:
// never a note's text, the model's reasons, a response body or the token.

import {
  API_LIMITS, FILE_RE, MARKDOWN, MAX_OBJECT_BYTES, listAgentScopes, noteEntry, readOrganizerState,
  readSearchEntries, recordOrganizerState, scopeDigest, setNoteEntries,
} from './agent-scopes.mjs';
import { AwsError } from './aws.mjs';
import { LABELS, readDomain, setDomain } from './domains.mjs';
import { labelBatch as modelBatch } from './label-client.mjs';
import { isLabelNoteName, labelNoteOf } from './label-notes.mjs';
import {
  askLabelModel, errorText, labelReport, labelResults, nextLabelRecord, planLabelBatches, plannedLabels, selectTouched, unreadScopeResults,
} from './label-run.mjs';

const bytes = (text) => Buffer.byteLength(text, 'utf8');
// The label whose `domain` field takes the most bytes in a search entry.
const LONGEST = LABELS.reduce((a, b) => (b.length > a.length ? b : a));
// The search entries of a scope (path -> entry), and whether such entries stay within what the
// memory API accepts of a scope (api/src/ops/write.ts).
const scopeEntriesOf = (entries, scope) => new Map(entries.filter((e) => e.path.startsWith(`${scope}/`)).map((e) => [e.path, e]));
const fits = (scopeEntries) => bytes(JSON.stringify([...scopeEntries.values()])) <= API_LIMITS.scopeBytes;

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
// scope has no record or with `all`, otherwise the notes whose ETag is not the one recorded, those
// with an exception, and those whose search entry carries no label (`bare`: paths), as after an
// older kit's Organize, which rewrites the entries without labels. A note is read in the version
// listed only: one that changed since (an agent wrote it) waits for the next run. `read`: the notes
// as labelNoteOf gives them, with `digest` (the ETag) and `text`; `present`: the paths of all the
// scope's notes; `left`: the notes not read, with why.
async function readScope({ s3, scope, files, record, all, domains, bare }) {
  const out = { read: [], present: [], left: new Map() };
  for (const f of files) {
    if (!isLabelNoteName(f.file)) continue;
    const path = `${scope}/${f.file}`;
    const recorded = record !== null && Object.hasOwn(record, path) && record[path] === f.etag;
    if (recorded && !all && !domains.exceptions.has(path) && !bare.has(path)) {
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

// Why the memory API would refuse note `n` of scope `s` with any label the model could give, so
// that it is not sent: its text after the frontmatter is over the API's limit, or with the longest
// label its scope's search entries (`scopeEntries`) would be. Null when every label fits.
function misfit(s, n, scopeEntries) {
  return refusal(scopeEntries, n.path, noteEntry(s.agent, n.file, setDomain(n.text, LONGEST).text));
}

// Why the memory API would refuse `entry` for note `path` among a scope's search entries
// (`scopeEntries`): LEFT.content (its text is over the limit), LEFT.scope (the scope's entries
// would be), or null when it fits.
function refusal(scopeEntries, path, entry) {
  if (bytes(entry.body) > API_LIMITS.contentBytes) return LEFT.content;
  return fits(new Map(scopeEntries).set(path, entry)) ? null : LEFT.scope;
}

// Writes the labels `planned` gives the notes of scope `s`, each only while it fits what the memory
// API accepts, then in one update the search entries of the written notes and of the notes read
// whose entry does not carry their label, each such entry while it fits, then the scope's record,
// where Organize's record moves to the listing the pass read with its own writes, if it was that
// listing. `entries`: the search entries as read before the writes. In a dry run, only what would be
// written.
async function writeScope({ s3For, s, planned, entries, started, dryRun }) {
  const out = { written: [], unchanged: [], left: new Map(), refreshed: 0, details: [], failed: false };
  const scopeEntries = scopeEntriesOf(entries, s.scope);
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
    const refused = refusal(scopeEntries, n.path, entry);
    if (refused !== null) {
      out.left.set(n.path, refused);
      continue;
    }
    if (dryRun) {
      out.written.push({ path: n.path, file: n.file, text, etag: null });
      scopeEntries.set(n.path, entry);
      continue;
    }
    if (broken !== null) {
      out.left.set(n.path, LEFT.failed);
      continue;
    }
    let put = null;
    try {
      client ??= await s3For();
      put = await client.put(n.path, text, { ifMatch: n.digest, contentType: MARKDOWN });
    } catch (err) {
      broken = errorText(err);
      out.left.set(n.path, LEFT.failed);
      continue;
    }
    if (put.status !== 'ok') {
      out.left.set(n.path, LEFT.meanwhile);
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
  // A note read that keeps its label but whose entry does not carry it (a labeled note found on a
  // first run, one whose label held under --all or an exception, an entry an older kit's Organize
  // rewrote) gets it in the same update, while it fits. A note whose write was tried is left out.
  const tried = new Set([...out.written.map((w) => w.path), ...out.left.keys()]);
  const updates = out.written.map((w) => ({ file: w.file, text: w.text }));
  for (const n of s.editable) {
    const current = scopeEntries.get(n.path);
    if (tried.has(n.path) || current === undefined || (current.domain ?? null) === readDomain(n.text)) continue;
    const entry = noteEntry(s.agent, n.file, n.text);
    if (!fits(new Map(scopeEntries).set(n.path, entry))) continue;
    scopeEntries.set(n.path, entry);
    updates.push({ file: n.file, text: n.text });
  }
  try {
    client ??= await s3For();
  } catch (err) {
    out.failed = true;
    const entriesToo = updates.length > 0 ? 'the search entries of the scope could not be updated and ' : '';
    out.details.push(`  - ${entriesToo}the run could not be recorded in index/organizer.json: ${errorText(err)}`);
    return out;
  }
  let entriesWritten = true;
  if (updates.length > 0) {
    try {
      await setNoteEntries(client, s.agent, updates);
      out.refreshed = updates.length - out.written.length;
    } catch (err) {
      entriesWritten = false;
      out.failed = true;
      const due = out.written.length > 0 ? '; it stays due for Organize, which rewrites them' : '';
      out.details.push(`  - the search entries of the scope could not be updated (${errorText(err)})${due}`);
    }
  }
  try {
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
// A scope whose only write was search entries given their note's label says how many.
function headline(s, out, { dryRun, idle, took }) {
  const scope = `label ${s.scope}`;
  const written = out.written.length;
  if (!took && out.refreshed > 0) return `${scope}: no label written, ${out.refreshed} search entry(ies) refreshed`;
  if (idle) return `${scope}: nothing to do`;
  if (dryRun) return `${scope}: dry-run, ${written} label(s) to set or change`;
  if (!took) return `${scope}: nothing written`;
  const notWritten = out.left.size > 0 ? `, ${out.left.size} not written` : '';
  return `${scope}: ${written > 0 ? 'applied' : 'no-change'}, ${written} label(s) written, ${out.unchanged.length} unchanged${notWritten}`;
}

// The label pass over the agent scopes of the bucket (every scope, or `opts.agentNames`). `s3For`
// gives an S3 client (agentScopesS3: reads get `signal`, writes do not, so that once they started they
// finish), `token()` the run's one token as `{ token, tokenAt }`, asked for only when there is a
// batch to send, `labelBatch` the model call (label-client's), `domains` and `persona` the label
// inputs. The ceiling is `maxBudgetUsd`, for this pass's own model cost. `failed`: the bucket
// could not be read, no token could be made, a batch failed, or a write failed. A signal before
// the writes stops it with nothing written; one later stops it before the next scope's writes.
// Returns the lines to print: one per scope, then the report without the model's reasons.
export async function labelAgentScopes({ config, opts, s3For, started, domains, persona, token, labelBatch = modelBatch, signal }) {
  const c = config.consolidate;
  const lines = [];
  const scopes = [];
  // The search entries as the run starts: a recorded note whose entry carries no label is read
  // again, and a touched note that no label would let fit its scope is not sent.
  let startEntries;
  try {
    const s3 = await s3For({ signal });
    const listing = await listAgentScopes(s3);
    const state = await readOrganizerState(s3);
    startEntries = await readSearchEntries(s3);
    const bare = new Set(startEntries.filter((e) => e.domain === undefined).map((e) => e.path));
    const agents = (opts.agentNames.length > 0 ? opts.agentNames : [...listing.keys()]).filter((agent) => listing.has(agent));
    for (const agent of agents) {
      const scope = `agents/${agent}`;
      const files = listing.get(agent);
      const record = recordOf(scope, state.scopes[agent]);
      scopes.push({ agent, scope, files, record, ...(await readScope({ s3, scope, files, record, all: opts.all, domains, bare })) });
    }
  } catch (err) {
    if (signal?.aborted) return { failed: false, lines };
    return { failed: true, lines: [`label: the agent scopes could not be read (${errorText(err)}); no label was written.`] };
  }
  // A run over every scope also names the exceptions of agent scopes it did not find: a typo there is never applied.
  const unread = opts.agentNames.length > 0 ? []
    : unreadScopeResults({ scopes: scopes.map((s) => s.scope), exceptions: domains.exceptions, own: (scope) => scope.startsWith('agents/') });
  // The report of the scopes, without the model's reasons, as lines.
  const reportLines = (results) => {
    const report = labelReport([...results, ...unread], { reasons: false });
    return report === '' ? [] : report.trimEnd().split('\n');
  };
  if (scopes.length === 0) return { failed: false, lines: ['label: nothing to do', ...reportLines([])] };

  // Only notes whose frontmatter the pass can edit go to the model or take an exception, and only
  // those that any label lets fit what the memory API accepts go to the model: the others stay
  // touched, with why.
  for (const s of scopes) {
    s.editable = s.read.filter((n) => n.skip === null);
    Object.assign(s, selectTouched({ notes: s.editable, record: s.record, all: opts.all }));
    const scopeEntries = scopeEntriesOf(startEntries, s.scope);
    for (const n of s.touched) {
      const why = domains.exceptions.has(n.path) ? null : misfit(s, n, scopeEntries);
      if (why !== null) s.left.set(n.path, why);
    }
  }
  const { exceptions, batches } = planLabelBatches({
    notes: scopes.flatMap((s) => s.editable), touched: scopes.flatMap((s) => s.touched.filter((n) => !s.left.has(n.path))),
    domains, batchNotes: c.label.batchNotes,
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
  const planned = plannedLabels(exceptions, asked.labels);

  // The entries again, right before the writes that are checked against them: the model calls take a while.
  let entries;
  try {
    entries = await readSearchEntries(await s3For({ signal }));
  } catch (err) {
    if (signal?.aborted) return { failed, lines };
    lines.push(`label: the search entries of the agent scopes could not be read (${errorText(err)}); no label was written.`);
    return { failed: true, lines };
  }
  const domainOf = new Map(entries.map((e) => [e.path, e.domain ?? null]));
  const results = [];
  for (const s of scopes) {
    if (signal?.aborted) break;
    const out = await writeScope({ s3For, s, planned, entries, started, dryRun: opts.dryRun });
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
  lines.push(...reportLines(results));
  return { failed, lines };
}
