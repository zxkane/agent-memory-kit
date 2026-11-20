// The model call of the label step: one request per batch of notes to an OpenAI-compatible
// Responses endpoint (Amazon Bedrock Mantle), with a short-term bearer token, and no agent loop or
// tools. The tokens come from a token file or from AWS's official token generator, the only
// packages the kit loads, here alone and only for a pass that signs its tokens. No error text holds
// a response body, a header, a credential, the token or the prompt.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeCode } from './aws.mjs';
import { LABELS } from './domains.mjs';
import { CUT_MARKER, NOTE_TEXT_CAP, capped } from './label-notes.mjs';
import { TOKEN_MAX_AGE_MS } from './label-run.mjs';
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
const NO_TOKEN = 'the label token could not be made';
// The kit's checkout, whose node_modules holds the packages of the label step.
const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALL = `run npm ci --omit=dev --ignore-scripts in ${KIT_DIR}`;
const TOKEN_PACKAGES = ['@aws/bedrock-token-generator', '@aws-sdk/credential-providers'];

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

// The text, usage or error of a parsed answer. A refusal and an incomplete answer are answers
// about the notes (`content`); a response that ended otherwise without completing is not.
function readResponse(data) {
  const usage = { input: count(data?.usage?.input_tokens), output: count(data?.usage?.output_tokens) };
  const status = typeof data?.status === 'string' && /^[a-z_]{1,32}$/.test(data.status) ? data.status : 'unknown';
  if (status !== 'completed') return { ok: false, error: `response status ${status}`, usage, content: status === 'incomplete' };
  const parts = (Array.isArray(data.output) ? data.output : [])
    .filter((item) => item?.type === 'message' && Array.isArray(item.content)).flatMap((item) => item.content);
  if (parts.some((part) => part?.type === 'refusal')) return { ok: false, error: 'model refused', usage, content: true };
  const text = parts.filter((part) => part?.type === 'output_text' && typeof part.text === 'string').map((part) => part.text).join('');
  return { ok: true, text, usage };
}

// The HTTP statuses that mean the request did not reach the model: busy, failing, not taking the
// token, or not there (the endpoint or the model). Every later request would most likely fail the
// same way.
const OUT_OF_REACH = (status) => status === 429 || status >= 500 || status === 401 || status === 403 || status === 404;

// What a token that could not be made may say: the HTTP status of an AWS answer and the error's
// name when it has the form of an AWS error code, never its message, which can hold an ARN, an
// account ID or text of the answer.
function tokenFailure(err) {
  const status = err?.$metadata?.httpStatusCode;
  return `${NO_TOKEN}: ${Number.isInteger(status) ? `${status} ` : ''}${safeCode(err?.name)}`;
}

// The token `provideToken` gives, or the abort of `signal` as soon as it comes: a token can take a
// while (a role's credentials take a request to STS), and an abort stops a request at once. No
// listener stays on the signal.
function tokenUntilAborted(provideToken, signal) {
  if (!signal) return Promise.resolve().then(provideToken);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    Promise.resolve().then(provideToken).then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

// One Responses request, with up to ATTEMPTS attempts for 429, 5xx and network errors (a timeout
// of one attempt is a network error). Right before each attempt it awaits a token of
// `provideToken`, never one of an earlier attempt. A token that cannot be made ends the request at
// once, with nothing sent and no other source tried, as a request that did not reach the model. An
// abort of the caller's signal stops it at once. A failure has `transport` true when the request
// did not reach the model (no token, a network error or a timeout, or HTTP 429, 5xx, 401, 403 or
// 404), false when the endpoint answered, and `content` true when the answer was about the notes:
// a refusal or an incomplete answer.
export async function requestLabels({ prompt, label, provideToken, fetchImpl = fetch, signal, sleep = defaultSleep }) {
  const started = Date.now();
  const done = (result) => ({ ...result, ms: Date.now() - started });
  const aborted = () => done({ ok: false, error: 'request aborted', transport: false, content: false });
  const body = JSON.stringify({
    model: label.model, input: prompt, max_output_tokens: MAX_OUTPUT_TOKENS, store: false, reasoning: { effort: label.reasoningEffort },
  });
  let error = 'Mantle Responses request failed';
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(BACKOFF_MS[attempt - 1] * (0.8 + Math.random() * 0.4));
    }
    if (signal?.aborted) return aborted();
    let token;
    try {
      token = await tokenUntilAborted(provideToken, signal);
    } catch (err) {
      if (signal?.aborted) return aborted();
      return done({ ok: false, error: tokenFailure(err), transport: true, content: false });
    }
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
      return done({ ok: false, error: `${NO_TOKEN}: not a token`, transport: true, content: false });
    }
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
        return done({ ok: false, error: `Mantle Responses HTTP ${res.status}`, transport: OUT_OF_REACH(res.status), content: false });
      }
      let data;
      try {
        data = JSON.parse(await readAnswer(res));
      } catch (err) {
        if (err instanceof Failure) return done({ ok: false, error: err.message, transport: false, content: false });
        if (err instanceof SyntaxError) return done({ ok: false, error: 'Mantle Responses answer is not JSON', transport: false, content: false });
        throw err;
      }
      const read = readResponse(data);
      return done(read.ok ? read : { ...read, transport: false });
    } catch (err) {
      if (signal?.aborted) return aborted();
      error = 'Mantle Responses request failed';
    }
  }
  // Every attempt got 429 or 5xx, or no answer.
  return done({ ok: false, error, transport: true, content: false });
}

export function costOf(usage, label) {
  return (usage.input * label.inputUsdPerMillion + usage.output * label.outputUsdPerMillion) / 1e6;
}

// Labels a batch of notes, each request with a token of its own from `provideToken`. An answer that
// fails parseLabelAnswer is asked once more; an HTTP or network failure (after its own retries), or
// a token that cannot be made, ends the batch. A failed batch has `transport` true when its request
// did not reach the model (see requestLabels), and `content` true when its last answer was about
// the notes: a refusal, an incomplete answer, or (twice) an answer that fails the check. Any other
// failure (another 4xx, an answer that is not JSON or is too large, a response that did not
// complete otherwise, an abort) has both false.
export async function labelBatch({ notes, persona, label, provideToken, fetchImpl, signal, sleep }) {
  const prompt = labelPrompt({ notes, persona });
  const ids = notes.map((n) => n.id);
  const usage = { input: 0, output: 0 };
  let requests = 0;
  let error = 'no answer';
  let transport = false;
  let content = false;
  for (let round = 0; round < 2; round += 1) {
    requests += 1;
    const res = await requestLabels({ prompt, label, provideToken, fetchImpl, signal, sleep });
    if (res.usage) {
      usage.input += res.usage.input;
      usage.output += res.usage.output;
    }
    if (!res.ok) {
      error = res.error;
      transport = res.transport === true;
      content = res.content === true;
      break;
    }
    try {
      const labels = parseLabelAnswer(res.text, ids);
      return { ok: true, labels, usage, costUsd: costOf(usage, label), requests };
    } catch (err) {
      error = err.message;
      content = true;
    }
  }
  return { ok: false, usage, costUsd: costOf(usage, label), requests, error, transport, content };
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

// The generator and the credential providers of the official AWS packages, loaded by `load` (a
// dynamic import), which the kit does only when a pass that signs its tokens takes its token
// source. When they cannot be loaded, the error names the command that installs them.
export async function loadTokenPackages(load = (name) => import(name)) {
  let generator;
  let providers;
  try {
    [generator, providers] = await Promise.all(TOKEN_PACKAGES.map((name) => load(name)));
  } catch (err) {
    const missing = err?.code === 'ERR_MODULE_NOT_FOUND' || err?.code === 'MODULE_NOT_FOUND';
    throw new Error(`the AWS token generator ${missing ? 'is not installed' : 'could not be loaded'}; ${INSTALL}`);
  }
  const { getTokenProvider } = generator;
  const { fromEnv, fromInstanceMetadata, fromTemporaryCredentials } = providers;
  return { getTokenProvider, fromEnv, fromInstanceMetadata, fromTemporaryCredentials };
}

// The credentials of `provider`, which must be temporary: long-lived keys never reach the token
// generator, as `environment` means the temporary credentials of a job.
const temporaryOnly = (provider) => async (...args) => {
  const credentials = await provider(...args);
  if (typeof credentials?.sessionToken !== 'string' || credentials.sessionToken === '') {
    throw Object.assign(new Error('the environment credentials have no session token'), { name: 'NoSessionToken' });
  }
  return credentials;
};

// The credentials that sign the label tokens, as the official providers give them: the instance
// metadata service (IMDSv2 only, as the kit's own client: never a fallback to IMDSv1), or the
// environment's temporary credentials, exchanged for the role's (a session as long as a token
// lasts, in the block's region) when the block names one. One source, never another one after it.
function labelCredentials(label, aws) {
  const base = label.credentials === 'environment'
    ? temporaryOnly(aws.fromEnv())
    : aws.fromInstanceMetadata({ ec2MetadataV1Disabled: true });
  if (!label.roleArn) return base;
  return aws.fromTemporaryCredentials({
    params: { RoleArn: label.roleArn, RoleSessionName: 'agent-memory-label', DurationSeconds: TOKEN_LIFETIME_SECONDS },
    masterCredentials: base,
    clientConfig: { region: label.region },
  });
}

// The token source of a pass, taken when it has a batch to send: `provideToken()`, awaited right
// before each request, and the moment the age of its token counts from (ms since the epoch, null
// when it has none), for the stop before a token gets too old.
// - A token file is read once: every request gets its token. Its age counts from the file's
//   modification time, as the job that issues the token writes the file at once (it may be long
//   before this pass starts). A file already TOKEN_MAX_AGE_MS old when the pass takes it was not
//   issued for the pass: it holds a token of unknown lifetime, such as a long-lived key, whose age
//   is not known (null), so it stops nothing; once such a key has expired, its requests get 401 or
//   403, which count toward the failure stop.
// - Otherwise one provider of the official token generator (`deps` replaces the packages in tests)
//   for the block's region, which makes a new token of an hour from the block's credentials for
//   every request, so that no token gets old (null). No token is kept: a provider that fails fails
//   that request, and no other source is tried.
export async function tokenForRun(label, { now = () => new Date(), deps } = {}) {
  if (label.tokenFile) {
    const { token, mtimeMs } = readTokenFile(label.tokenFile);
    return { provideToken: async () => token, tokenAt: now().getTime() - mtimeMs >= TOKEN_MAX_AGE_MS ? null : mtimeMs };
  }
  if (label.credentials !== 'environment' && label.credentials !== 'instance') throw new Error('the label block names no token source');
  const aws = deps ?? (await loadTokenPackages());
  const provideToken = aws.getTokenProvider({
    region: label.region, credentials: labelCredentials(label, aws), expiresInSeconds: TOKEN_LIFETIME_SECONDS,
  });
  return { provideToken, tokenAt: null };
}
