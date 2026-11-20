// The model call of the label step: one request per batch of notes to an OpenAI-compatible
// Responses endpoint (Amazon Bedrock Mantle), with a short-term bearer token, and no agent loop or
// tools. No dependencies. No error text holds a response body, a header, the token or the prompt.

import { assumeRole, bedrockToken, environmentCredentials, imdsCredentials } from './aws.mjs';
import { LABELS } from './domains.mjs';
import { CUT_MARKER, NOTE_TEXT_CAP, capped } from './label-notes.mjs';
import { renderPrompt } from './model-run.mjs';
import { readRegular } from './workdir.mjs';

export { CUT_MARKER, NOTE_TEXT_CAP };

const MAX_OUTPUT_TOKENS = 16000;
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const ATTEMPT_TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;
const BACKOFF_MS = [500, 1500];
const MAX_REASON_CHARS = 300;
const MAX_TOKEN_FILE_BYTES = 16 * 1024;
const TOKEN_RE = /^[A-Za-z0-9+/=._-]+$/;
const TOKEN_LIFETIME_SECONDS = 3600;

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// A `<` that starts a structural tag of the prompt becomes `&lt;`, so a note cannot close its own
// block or open another one. Any other `<` stays, because notes hold code.
// Unicode format characters (zero-width, soft hyphen) count as white space here.
const STRUCTURAL_TAG_RE = /<(?=[\s\p{Cf}]*\/?[\s\p{Cf}]*(?:notes?|persona)\b)/giu;
const escapeTags = (text) => String(text ?? '').replace(STRUCTURAL_TAG_RE, '&lt;');
const escapeAttr = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NAME_CAP = 200;
const DESCRIPTION_CAP = 1000;

// The first `max` UTF-16 units of a text, without a lone high surrogate at the end.
function head(text, max) {
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
const cutTo = (text, max) => (text.length > max ? `${head(text, max)}…` : text);

// One note as the model sees it. The body is cut by the rule collectScopeNotes uses.
export function noteBlock({ id, path, default: label, name, description, body }) {
  return [
    `<note id="${escapeAttr(id)}" path="${escapeAttr(path)}" default="${escapeAttr(label)}">`,
    `name: ${escapeTags(cutTo(String(name ?? ''), NAME_CAP))}`,
    `description: ${escapeTags(cutTo(String(description ?? ''), DESCRIPTION_CAP))}`,
    '',
    escapeTags(capped(String(body ?? ''))),
    '</note>',
  ].join('\n');
}

export function labelPrompt({ notes, persona }) {
  return renderPrompt('label', { persona, notes: notes.map(noteBlock).join('\n\n') });
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
// A reason of the model as one line: control characters become spaces, runs of spaces collapse.
const oneLine = (text) => text.replace(/[\p{Cc}\u2028\u2029]/gu, ' ').replace(/ {2,}/g, ' ').trim();

const stripFence = (text) => /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text)?.[1] ?? text;

// The labels of an answer, by note id, in the order of the answer. Throws when the answer is not a
// complete, valid label for every id of `ids`.
export function parseLabelAnswer(text, ids) {
  let data = null;
  try {
    data = JSON.parse(stripFence(String(text)).trim());
  } catch {
    data = null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('no JSON object');
  if (!Array.isArray(data.labels)) throw new Error('labels missing');
  const wanted = new Set(ids);
  const labels = new Map();
  for (const entry of data.labels) {
    const id = entry?.id;
    if (typeof id !== 'string' || !wanted.has(id) || labels.has(id)) {
      throw new Error(typeof id === 'string' && SAFE_ID_RE.test(id) ? `unknown or duplicate id ${id}` : 'unknown or duplicate id');
    }
    if (!LABELS.includes(entry.label)) throw new Error(`bad label for ${id}`);
    const reason = typeof entry.reason === 'string' ? head(oneLine(entry.reason), MAX_REASON_CHARS).trim() : '';
    labels.set(id, { label: entry.label, reason });
  }
  if (labels.size < wanted.size) throw new Error(`${wanted.size - labels.size} ids missing`);
  return labels;
}

class Failure extends Error {}

// The body of a response as text, up to MAX_ANSWER_BYTES.
async function readAnswer(res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > MAX_ANSWER_BYTES) throw new Failure('Mantle Responses answer too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const count = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

// The text, usage or error of a parsed answer.
function readResponse(data) {
  const usage = { input: count(data?.usage?.input_tokens), output: count(data?.usage?.output_tokens) };
  const status = typeof data?.status === 'string' && /^[a-z_]{1,32}$/.test(data.status) ? data.status : 'unknown';
  if (status !== 'completed') return { ok: false, error: `response status ${status}`, usage };
  const parts = (Array.isArray(data.output) ? data.output : [])
    .filter((item) => item?.type === 'message' && Array.isArray(item.content)).flatMap((item) => item.content);
  if (parts.some((part) => part?.type === 'refusal')) return { ok: false, error: 'model refused', usage };
  const text = parts.filter((part) => part?.type === 'output_text' && typeof part.text === 'string').map((part) => part.text).join('');
  return { ok: true, text, usage };
}

// The HTTP statuses that mean the request did not reach the model: busy, failing, or not taking
// the token. Every later request would most likely fail the same way.
const OUT_OF_REACH = (status) => status === 429 || status >= 500 || status === 401 || status === 403;

// One Responses request, with up to ATTEMPTS attempts for 429, 5xx and network errors (a timeout
// of one attempt is a network error). An abort of the caller's signal stops it at once. A failure
// has `transport` true when the request did not reach the model (a network error or a timeout, or
// HTTP 429, 5xx, 401 or 403), false when the endpoint answered.
export async function requestLabels({ prompt, label, token, fetchImpl = fetch, signal, sleep = defaultSleep }) {
  const started = Date.now();
  const done = (result) => ({ ...result, ms: Date.now() - started });
  const body = JSON.stringify({
    model: label.model, input: prompt, max_output_tokens: MAX_OUTPUT_TOKENS, store: false, reasoning: { effort: label.reasoningEffort },
  });
  let error = 'Mantle Responses request failed';
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(BACKOFF_MS[attempt - 1] * (0.8 + Math.random() * 0.4));
    }
    if (signal?.aborted) return done({ ok: false, error: 'request aborted', transport: false });
    const limit = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${label.endpoint}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body,
        redirect: 'error',
        signal: signal ? AbortSignal.any([limit, signal]) : limit,
      });
      if (res.status === 429 || res.status >= 500) {
        error = `Mantle Responses HTTP ${res.status}`;
        await res.body?.cancel().catch(() => {});
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => {});
        return done({ ok: false, error: `Mantle Responses HTTP ${res.status}`, transport: OUT_OF_REACH(res.status) });
      }
      let data;
      try {
        data = JSON.parse(await readAnswer(res));
      } catch (err) {
        if (err instanceof Failure) return done({ ok: false, error: err.message, transport: false });
        if (err instanceof SyntaxError) return done({ ok: false, error: 'Mantle Responses answer is not JSON', transport: false });
        throw err;
      }
      const read = readResponse(data);
      return done(read.ok ? read : { ...read, transport: false });
    } catch (err) {
      if (signal?.aborted) return done({ ok: false, error: 'request aborted', transport: false });
      error = 'Mantle Responses request failed';
    }
  }
  // Every attempt got 429 or 5xx, or no answer.
  return done({ ok: false, error, transport: true });
}

export function costOf(usage, label) {
  return (usage.input * label.inputUsdPerMillion + usage.output * label.outputUsdPerMillion) / 1e6;
}

// Labels a batch of notes. An answer that fails parseLabelAnswer is asked once more; an HTTP or
// network failure (after its own retries) ends the batch. A failed batch has `transport` true when
// its request did not reach the model (see requestLabels); a refusal, an incomplete answer, two
// answers that fail the check and any other 4xx are answers, with `transport` false.
export async function labelBatch({ notes, persona, label, token, fetchImpl, signal, sleep }) {
  const prompt = labelPrompt({ notes, persona });
  const ids = notes.map((n) => n.id);
  const usage = { input: 0, output: 0 };
  let requests = 0;
  let error = 'no answer';
  let transport = false;
  for (let round = 0; round < 2; round += 1) {
    requests += 1;
    const res = await requestLabels({ prompt, label, token, fetchImpl, signal, sleep });
    if (res.usage) {
      usage.input += res.usage.input;
      usage.output += res.usage.output;
    }
    if (!res.ok) {
      error = res.error;
      transport = res.transport === true;
      break;
    }
    try {
      const labels = parseLabelAnswer(res.text, ids);
      return { ok: true, labels, usage, costUsd: costOf(usage, label), requests };
    } catch (err) {
      error = err.message;
    }
  }
  return { ok: false, usage, costUsd: costOf(usage, label), requests, error, transport };
}

const BAD_TOKEN_FILE = 'the label token file is not a token';
const UNREADABLE_TOKEN_FILE = 'the label token file cannot be read';

// The token of a file, a regular file of at most 16 KiB and never a link (workdir's reader), with
// the file's modification time (ms) from the same open file.
function readTokenFile(path) {
  const info = {};
  let buf;
  try {
    buf = readRegular(path, info, { maxBytes: MAX_TOKEN_FILE_BYTES });
  } catch {
    throw new Error(UNREADABLE_TOKEN_FILE);
  }
  if (buf === null) throw new Error(info.missing ? UNREADABLE_TOKEN_FILE : BAD_TOKEN_FILE);
  const token = buf.toString('utf8').trim();
  if (!TOKEN_RE.test(token)) throw new Error(BAD_TOKEN_FILE);
  return { token, mtimeMs: info.mtimeMs };
}

// A bearer token for the label endpoint: the token file when the label block names one, otherwise
// a short-term token signed with the instance or environment credentials (of the role, when the
// block names one). The role session lasts as long as the token, which stops working with the
// credentials that signed it.
export async function labelToken(label, { now = () => new Date(), env = process.env, fetchImpl } = {}) {
  if (label.tokenFile) return readTokenFile(label.tokenFile).token;
  let credentials;
  if (label.credentials === 'environment') credentials = environmentCredentials(env);
  else if (label.credentials === 'instance') credentials = await imdsCredentials({ fetchImpl });
  else throw new Error('the label block names no token source');
  if (label.roleArn) {
    credentials = await assumeRole({
      roleArn: label.roleArn, sessionName: 'agent-memory-label', region: label.region, credentials,
      durationSeconds: TOKEN_LIFETIME_SECONDS, fetchImpl, now,
    });
  }
  return bedrockToken({ region: label.region, credentials, now: now(), expiresInSeconds: TOKEN_LIFETIME_SECONDS });
}

// The token of a run and the moment its age counts from (ms since the epoch), for the stop before
// a token gets too old: a token file's modification time, as the job that issues the token writes
// the file at once (it may be long before this run starts), or the moment the token is signed.
export async function tokenForRun(label, { now = () => new Date(), env = process.env, fetchImpl } = {}) {
  if (label.tokenFile) {
    const { token, mtimeMs } = readTokenFile(label.tokenFile);
    return { token, tokenAt: mtimeMs };
  }
  const signedAt = now();
  return { token: await labelToken(label, { now: () => signedAt, env, fetchImpl }), tokenAt: signedAt.getTime() };
}
