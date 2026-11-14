// Small helpers for reading notes: frontmatter, index links and "retired note" stubs.

export const INDEX = 'MEMORY.md';
export const NOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,196}\.md$/;

const STUB_RE = /^MOVED TO \[\[(?:(global):)?([A-Za-z0-9][A-Za-z0-9._-]{0,193})\]\]$/;
const LINK_RE = /\]\(([^()\s]+)\)/g;

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) return v.slice(1, -1);
  return v;
}

// Reads the leading frontmatter block. Without a block, or without its closing line, every field is null.
export function parseNote(text) {
  const result = { name: null, description: null, type: null };
  const lines = String(text).split(/\r?\n/);
  if (lines[0] !== '---') return result;
  const end = lines.indexOf('---', 1);
  if (end === -1) return result;
  let inMetadata = false;
  for (const line of lines.slice(1, end)) {
    if (/^\s/.test(line)) {
      const m = inMetadata && /^\s+type:(.*)$/.exec(line);
      if (m) result.type = unquote(m[1]);
      continue;
    }
    inMetadata = /^metadata:\s*$/.test(line);
    const m = /^(name|description):(.*)$/.exec(line);
    if (m) result[m[1]] = unquote(m[2]);
  }
  return result;
}

// The note file names an index links to, as `](name.md)`.
export function indexRefs(indexText) {
  const refs = new Set();
  for (const m of String(indexText).matchAll(LINK_RE)) {
    if (NOTE_NAME_RE.test(m[1])) refs.add(m[1]);
  }
  return refs;
}

// A retired note holds only `MOVED TO [[name]]` or `MOVED TO [[global:name]]`.
export function stubTarget(text) {
  const m = STUB_RE.exec(String(text).trim());
  return m ? { folder: m[1] ? 'global' : 'same', name: m[2] } : null;
}

export function indexStats(indexText) {
  const text = String(indexText);
  if (text === '') return { lines: 0, bytes: 0 };
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length;
  return { lines, bytes: Buffer.byteLength(text, 'utf8') };
}
