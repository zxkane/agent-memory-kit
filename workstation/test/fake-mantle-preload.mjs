// Preloaded into a spawned driver (NODE_OPTIONS=--import): `fetch` to a Bedrock Mantle host
// (bedrock-mantle.<region>.api.aws) is answered here, never by the network. FAKE_MANTLE_FILE (JSON:
// { labels: { <path>: <label> }, fail?: { status, times, after? }, refuse?: { times }, delayMs?,
// advanceMs? }) is read on every request: each note of the prompt (its `<note id="…" path="…"` tag)
// gets the label of its path, `general` when the file names none, and the answer is a completed
// Responses document with usage { input_tokens: 1000, output_tokens: 50 }. With `fail`, after the
// first `after` requests of the process (0 when absent) the next `times` requests get the HTTP
// status `status` and a body that a caller must never print (it holds FAKE-MANTLE-BODY). With
// `refuse`, the first `times` requests of the process that do not fail get a completed answer that
// is a refusal. With `delayMs`, each answer comes that much later, or fails at once when the
// request's signal aborts, as `fetch` does. With `advanceMs`, each request moves the process's
// `Date.now()` that much on, as if the request had taken that long (`new Date()` is not moved).
// Each request is appended to FAKE_MANTLE_LOG (JSON lines: { paths, auth }, `auth` true when it
// carried a bearer token) when that is set. Importing this file replaces `fetch` and `Date.now` of
// the importing process: tests only preload it.
import { appendFileSync, readFileSync } from 'node:fs';

const FAIL_BODY = '{"error":"FAKE-MANTLE-BODY-0042: a body that may echo note text"}';

const realFetch = globalThis.fetch;
const realNow = Date.now.bind(Date);
const HOST_RE = /^bedrock-mantle\.[a-z0-9-]+\.api\.aws$/;
const NOTE_TAG_RE = /<note id="([^"]*)" path="([^"]*)"/g;
const unescape = (value) => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

let seen = 0;
let failed = 0;
let refused = 0;
let skew = 0;

Date.now = () => realNow() + skew;

globalThis.fetch = async (url, init = {}) => {
  if (!HOST_RE.test(new URL(url).hostname)) return realFetch(url, init);
  const spec = JSON.parse(readFileSync(process.env.FAKE_MANTLE_FILE, 'utf8'));
  const { input } = JSON.parse(init.body);
  const notes = [...String(input).matchAll(NOTE_TAG_RE)].map(([, id, path]) => ({ id: unescape(id), path: unescape(path) }));
  const auth = /^Bearer \S+$/.test(new Headers(init.headers).get('authorization') ?? '');
  if (process.env.FAKE_MANTLE_LOG) {
    appendFileSync(process.env.FAKE_MANTLE_LOG, `${JSON.stringify({ paths: notes.map((n) => n.path), auth })}\n`);
  }
  seen += 1;
  skew += spec.advanceMs ?? 0;
  if (spec.delayMs) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, spec.delayMs);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      }, { once: true });
    });
  }
  const fail = spec.fail;
  if (fail && seen > (fail.after ?? 0) && failed < fail.times) {
    failed += 1;
    return new Response(FAIL_BODY, { status: fail.status, headers: { 'content-type': 'application/json' } });
  }
  const usage = { input_tokens: 1000, output_tokens: 50 };
  if (spec.refuse && refused < spec.refuse.times) {
    refused += 1;
    const refusal = { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'FAKE-MANTLE-REFUSAL' }] }], usage };
    return new Response(JSON.stringify(refusal), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const labels = notes.map(({ id, path }) => ({ id, label: spec.labels?.[path] ?? 'general', reason: `fake reason for ${path}` }));
  const answer = {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ labels }) }] }],
    usage,
  };
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
};
