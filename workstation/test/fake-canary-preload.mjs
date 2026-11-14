// Preloaded into a spawned `run.sh canary` (NODE_OPTIONS=--import): replaces `fetch` with the fake of
// fake-canary-api.mjs, configured by the FAKE_CANARY environment variable (JSON).
import { makeFakeFetch } from './fake-canary-api.mjs';

globalThis.fetch = makeFakeFetch(JSON.parse(process.env.FAKE_CANARY));
