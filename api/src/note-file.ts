import type { NoteType } from './validate.ts';

const LINK_RE = /\]\([^()\s]*\.md\)/;

export function composeNote(input: { name: string; description: string; type: NoteType | string; content: string }): string {
  const body = input.content.replace(/\r\n?/g, '\n').trimEnd();
  return [
    '---',
    `name: ${input.name}`,
    `description: ${JSON.stringify(input.description)}`,
    'metadata:',
    `  type: ${input.type}`,
    '---',
    '',
    body,
  ].join('\n') + '\n';
}

function splitLines(text: string | null): string[] {
  if (text === null || text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function upsertIndexLine(indexText: string | null, name: string, description: string): string {
  const line = `- [${name}](${name}.md) — ${description}`;
  // The name is a lower-case slug, so it needs no escaping inside the pattern.
  const target = new RegExp(`^\\s*- \\[[^\\]]*\\]\\(${name}\\.md\\)`);
  const lines = splitLines(indexText);
  const at = lines.findIndex((l) => target.test(l));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  return lines.join('\n') + '\n';
}

export function countIndexNotes(indexText: string | null): number {
  return splitLines(indexText).filter((l) => LINK_RE.test(l)).length;
}
