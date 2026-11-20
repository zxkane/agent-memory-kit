// Note labels: the `domain` of a note, the private inputs that decide it, and the tags on index lines.
// Its imports are node built-ins and kit modules that have no side effects at import and load no AWS
// code, so that the session-start hook may use it.
import { join } from 'node:path';
import { AGENT_RE, INDEX, NOTE_NAME_RE, PROJECT_RE, unquote } from './notes.mjs';
import { readRegular } from './workdir.mjs';

export const LABELS = Object.freeze(['work', 'personal', 'general']);

const MAX_DOMAINS_BYTES = 1024 * 1024;
const MAX_PERSONA_CHARS = 20000;
const MAX_NOTE_BYTES = 1024 * 1024;
const TAG_LINE_RE = /^- \[[^\]]*\]\(([A-Za-z0-9][A-Za-z0-9._-]*\.md)\) — /;
// What may stand around and inside an author-written tag without showing: white space other than a
// line end, and Unicode format characters (zero-width characters, the soft hyphen, joiners). One
// character class, so that a long run of them is matched once, not in every way it could split.
const GAP = '[[\\s\\p{Cf}]--[\\r\\n]]*';
const spaced = (word) => [...word].join(GAP);
// A leading run of `[work]` / `[personal]` tags in any letter case, with the gaps before, between,
// inside and after them. Homoglyphs and full-width brackets are not tags.
const TAG_RUN_RE = new RegExp(`^${GAP}(?:\\[${GAP}(?:${spaced('work')}|${spaced('personal')})${GAP}\\]${GAP})+`, 'iv');
const SCOPE_RE = /^(?:global|projects\/([^/]+)|agents\/([^/]+))$/;

const bare = line => line.replace(/\r$/, '');

// Finds the frontmatter block and the metadata block in it, by parseNote's rules. Lines keep their `\r`.
// `children` holds the indexes of the indented lines under `metadata:`. A blank or white-space line
// belongs to the block when an indented line of it follows, as in YAML; it is not a child.
function locate(text) {
  const lines = String(text).split('\n');
  if (bare(lines[0]) !== '---') return { skip: 'no frontmatter' };
  const end = lines.findIndex((line, i) => i > 0 && bare(line) === '---');
  if (end === -1) return { skip: 'frontmatter not closed' };
  let meta = -1;
  for (let i = 1; i < end; i++) {
    if (!/^metadata:/.test(lines[i])) continue;
    if (!/^metadata:\s*$/.test(lines[i])) return { skip: 'metadata is not a block' };
    meta = i;
    break;
  }
  const children = [];
  if (meta !== -1) {
    for (let i = meta + 1; i < end; i++) {
      if (/^\s+\S/.test(lines[i])) children.push(i);
      else if (/\S/.test(lines[i])) break;
    }
  }
  return { lines, end, meta, children };
}

// The label under `metadata:`, or null when the note has none or a value outside LABELS.
export function readDomain(text) {
  const found = locate(text);
  if (found.skip) return null;
  for (const i of found.children) {
    const m = /^\s+domain:(.*)$/.exec(bare(found.lines[i]));
    if (m) {
      const value = unquote(m[1]);
      return LABELS.includes(value) ? value : null;
    }
  }
  return null;
}

// Writes `domain: <label>` under `metadata:`: replaces the first one, drops later ones, adds one when
// there is none, and adds the block when there is none. Everything else stays as it was.
export function setDomain(text, label) {
  if (!LABELS.includes(label)) throw new TypeError(`unknown label: ${label}`);
  const found = locate(text);
  if (found.skip) return { skip: found.skip };
  const { lines, end, meta, children } = found;
  const cr = bare(lines[0]) === lines[0] ? '' : '\r';
  const indentOf = i => /^\s*/.exec(lines[i])[0];
  const domainAt = children.filter(i => /^\s+domain:/.test(lines[i]));
  let out;
  if (meta === -1) {
    out = [...lines.slice(0, end), `metadata:${cr}`, `  domain: ${label}${cr}`, ...lines.slice(end)];
  } else if (domainAt.length) {
    out = lines.flatMap((line, i) => {
      if (i === domainAt[0]) return [`${indentOf(i)}domain: ${label}${cr}`];
      return domainAt.includes(i) ? [] : [line];
    });
  } else {
    const last = children.length ? children.at(-1) : meta;
    const indent = children.length ? indentOf(children[0]) : '  ';
    out = [...lines.slice(0, last + 1), `${indent}domain: ${label}${cr}`, ...lines.slice(last + 1)];
  }
  return { text: out.join('\n') };
}

function validScope(scope) {
  const m = SCOPE_RE.exec(scope);
  if (!m) return false;
  if (m[1] !== undefined) return PROJECT_RE.test(m[1]);
  if (m[2] !== undefined) return AGENT_RE.test(m[2]);
  return true;
}

function validException(path) {
  const slash = path.lastIndexOf('/');
  if (slash === -1) return false;
  const file = path.slice(slash + 1);
  return validScope(path.slice(0, slash)) && file !== INDEX && NOTE_NAME_RE.test(file);
}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Parses the private domains file. Names the first problem found; never throws.
export function parseDomains(text) {
  const fail = problem => ({ value: null, problem });
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return fail('not JSON');
  }
  if (!isObject(data)) return fail('not JSON');
  if (data.version !== 1) return fail('version');
  if (Object.keys(data).some(k => !['version', 'defaults', 'exceptions'].includes(k))) return fail('an unknown key');
  const maps = {};
  for (const [key, valid] of [['defaults', validScope], ['exceptions', validException]]) {
    if (!isObject(data[key])) return fail(key);
    for (const [name, label] of Object.entries(data[key])) {
      if (!valid(name) || !LABELS.includes(label)) return fail(key);
    }
    maps[key] = new Map(Object.entries(data[key]));
  }
  return { value: { defaults: maps.defaults, exceptions: maps.exceptions }, problem: null };
}

// The default label of a scope (`global`, `projects/<name>`, `agents/<agent>`).
export function scopeDefault(domains, scope) {
  return domains.defaults.get(scope) ?? 'general';
}

// The text of a regular file of at most `maxBytes` bytes (workdir's reader: never a link, never a
// wait on a FIFO), or null when it cannot be read.
function readText(file, maxBytes) {
  try {
    return readRegular(file, null, { maxBytes })?.toString('utf8') ?? null;
  } catch {
    return null;
  }
}

// Reads the two private inputs. Names the first one that cannot be used.
export function readLabelInputs({ domainsFile, personaFile }) {
  const d = readText(domainsFile, MAX_DOMAINS_BYTES);
  if (d === null) return { problem: 'domainsFile' };
  const parsed = parseDomains(d);
  if (parsed.problem) return { problem: `domainsFile: ${parsed.problem}` };
  // A persona over the limit has more than MAX_PERSONA_CHARS characters, so a few extra bytes are enough to tell.
  const p = readText(personaFile, 4 * MAX_PERSONA_CHARS + 4096);
  const persona = p === null ? '' : p.trim();
  if (!persona || persona.length > MAX_PERSONA_CHARS) return { problem: 'personaFile' };
  return { domains: parsed.value, persona };
}

// The tag of an index line comes only from the note it links. In a line that links a note of its folder, a run
// of tags right after the dash (TAG_RUN_RE) is removed with the white space or format characters right after it,
// then the note's own tag is inserted: work and personal get one, general and unlabeled notes none. The rest
// of the line keeps its text exactly. Tagging a tagged line gives the same line.
export function tagLine(line, label) {
  const m = TAG_LINE_RE.exec(line);
  if (!m) return line;
  const rest = line.slice(m[0].length).replace(TAG_RUN_RE, '');
  const tag = label === 'work' || label === 'personal' ? `[${label}] ` : '';
  return `${line.slice(0, m[0].length)}${tag}${rest}`;
}

// Tags every index line by the label of the note it links in `dir`. A note that cannot be read (also a link, a
// FIFO or a file over MAX_NOTE_BYTES) leaves its line as it was.
export function tagIndexLines(lines, dir) {
  return lines.map(line => {
    const m = TAG_LINE_RE.exec(line);
    if (!m) return line;
    const note = readText(join(dir, m[1]), MAX_NOTE_BYTES);
    return note === null ? line : tagLine(line, readDomain(note));
  });
}
