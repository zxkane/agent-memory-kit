import type { Domain } from './snapshot.ts';

// An index line of a note in the same folder: "- [title](file.md) — description", not yet tagged.
const LINE = /^- \[[^\]]*\]\(([A-Za-z0-9][A-Za-z0-9._-]*\.md)\) — (?!\[(work|personal)\] )/;

// Puts [work] or [personal] after the first " — " of the line of each note with that label.
// general and unlabeled notes, and every other line, stay as they are.
export function tagIndexText(text: string, domains: Map<string, Domain>): string {
  return text
    .split('\n')
    .map((line) => {
      const m = LINE.exec(line);
      if (!m) return line;
      const domain = domains.get(m[1]!);
      if (domain !== 'work' && domain !== 'personal') return line;
      return `${line.slice(0, m[0].length)}[${domain}] ${line.slice(m[0].length)}`;
    })
    .join('\n');
}
