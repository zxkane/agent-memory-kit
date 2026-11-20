import { tagLine } from '../../workstation/lib/domains.mjs';
import type { Domain } from './snapshot.ts';

// The tag of an index line comes only from the note: any [work] / [personal] written after the line's dash is
// replaced by the note's own tag, and general and unlabeled notes get none (the rule of tagLine on the workstation).
export function tagIndexText(text: string, domains: Map<string, Domain>): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^- \[[^\]]*\]\(([A-Za-z0-9][A-Za-z0-9._-]*\.md)\)/.exec(line);
      return tagLine(line, m ? (domains.get(m[1]!) ?? null) : null) as string;
    })
    .join('\n');
}
