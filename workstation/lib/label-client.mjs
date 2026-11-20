// The model call of the label step: one request per batch of notes to an OpenAI-compatible
// Responses endpoint (Amazon Bedrock Mantle), with a short-term bearer token, and no agent loop or
// tools. No dependencies. No error text holds a response body, a header, the token or the prompt.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { assumeRole, bedrockToken, environmentCredentials, imdsCredentials } from './aws.mjs';
import { LABELS } from './domains.mjs';
import { CUT_MARKER, NOTE_TEXT_CAP, capped } from './label-notes.mjs';
import { renderPrompt } from './model-run.mjs';

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
const STRUCTURAL_TAG_RE = /<(?=\s*\/?\s*(?:notes?|persona)\b)/gi;
const escapeTags = (text) => String(text ?? '').replace(STRUCTURAL_TAG_RE, '&lt;');

// One note as the model sees it. The body is cut by the rule collectScopeNotes uses.
export function noteBlock({ id, path, default: label, name, description, body }) {
  return [
    `<note id="${id}" path="${path}" default="${label}">`,
    `name: ${escapeTags(name)}`,
    `description: ${escapeTags(description)}`,
    '',
    escapeTags(capped(String(body ?? ''))),
    '</note>',
  ].join('\n');
}

export function labelPrompt({ notes, persona }) {
  return renderPrompt('label', { persona, notes: notes.map(noteBlock).join('\n\n') });
}

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
    if (typeof id !== 'string' || !wanted.has(id) || labels.has(id)) throw new Error(`unknown or duplicate id ${String(id).slice(0, 80)}`);
    if (!LABELS.includes(entry.label)) throw new Error(`bad label for ${id}`);
    const reason = typeof entry.reason === 'string' ? entry.reason.trim().slice(0, MAX_REASON_CHARS) : '';
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
  const status = typeof data?.status === 'string' && /^[a-z_]{1,32}$/.test(data.status) ? data.status : 'unknown';
  if (status !== 'completed') return { ok: false, error: `response status ${status}` };
  const parts = (Array.isArray(data.output) ? data.output : [])
    .filter((item) => item?.type === 'message' && Array.isArray(item.content)).flatMap((item) => item.content);
  if (parts.some((part) => part?.type === 'refusal')) return { ok: false, error: 'model refused' };
  const text = parts.filter((part) => part?.type === 'output_text' && typeof part.text === 'string').map((part) => part.text).join('');
  return { ok: true, text, usage: { input: count(data.usage?.input_tokens), output: count(data.usage?.output_tokens) } };
}

// One Responses request, with up to ATTEMPTS attempts for 429, 5xx and network errors (a timeout
// of one attempt is a network error). An abort of the caller's signal stops it at once.
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
    if (signal?.aborted) return done({ ok: false, error: 'request aborted' });
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
        return done({ ok: false, error: `Mantle Responses HTTP ${res.status}` });
      }
      let data;
      try {
        data = JSON.parse(await readAnswer(res));
      } catch (err) {
        if (err instanceof Failure) return done({ ok: false, error: err.message });
        if (err instanceof SyntaxError) return done({ ok: false, error: 'Mantle Responses answer is not JSON' });
        throw err;
      }
      return done(readResponse(data));
    } catch (err) {
      if (signal?.aborted) return done({ ok: false, error: 'request aborted' });
      error = 'Mantle Responses request failed';
    }
  }
  return done({ ok: false, error });
}

export function costOf(usage, label) {
  return (usage.input * label.inputUsdPerMillion + usage.output * label.outputUsdPerMillion) / 1e6;
}

// Labels a batch of notes. An answer that fails parseLabelAnswer is asked once more; an HTTP or
// network failure (after its own retries) ends the batch.
export async function labelBatch({ notes, persona, label, token, fetchImpl, signal, sleep }) {
  const prompt = labelPrompt({ notes, persona });
  const ids = notes.map((n) => n.id);
  const usage = { input: 0, output: 0 };
  let requests = 0;
  let error = 'no answer';
  for (let round = 0; round < 2; round += 1) {
    requests += 1;
    const res = await requestLabels({ prompt, label, token, fetchImpl, signal, sleep });
    if (res.usage) {
      usage.input += res.usage.input;
      usage.output += res.usage.output;
    }
    if (!res.ok) {
      error = res.error;
      break;
    }
    try {
      const labels = parseLabelAnswer(res.text, ids);
      return { ok: true, labels, usage, costUsd: costOf(usage, label), requests };
    } catch (err) {
      error = err.message;
    }
  }
  return { ok: false, usage, costUsd: costOf(usage, label), requests, error };
}

const BAD_TOKEN_FILE = 'the label token file is not a token';

// The token of a file: a regular file of at most 16 KiB, never a link.
function readTokenFile(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    throw new Error(err.code === 'ELOOP' ? BAD_TOKEN_FILE : 'the label token file cannot be read');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_TOKEN_FILE_BYTES) throw new Error(BAD_TOKEN_FILE);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    const token = buf.subarray(0, off).toString('utf8').trim();
    if (!TOKEN_RE.test(token)) throw new Error(BAD_TOKEN_FILE);
    return token;
  } finally {
    closeSync(fd);
  }
}

// A bearer token for the label endpoint: the token file when the label block names one, otherwise
// a short-term token signed with the instance or environment credentials (of the role, when the
// block names one). The role session lasts as long as the token, which stops working with the
// credentials that signed it.
export async function labelToken(label, { now = () => new Date(), env = process.env, fetchImpl } = {}) {
  if (label.tokenFile) return readTokenFile(label.tokenFile);
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
