// Usage: node scripts/render-openapi.ts <base url>
// Prints openapi.json with servers[0].url replaced by the given https:// base URL.
import { readFileSync } from 'node:fs';

const url = process.argv[2];
if (url === undefined || !url.startsWith('https://') || !URL.canParse(url)) {
  console.error('Usage: render-openapi.ts https://<base url>');
  process.exit(1);
}

const doc = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
doc.servers[0].url = url;
console.log(JSON.stringify(doc, null, 2));
