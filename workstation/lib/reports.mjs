// The reports of consolidation: `_reports/<date>-<host>-<kind>-<scope>.md` of an Extract or
// Organize scope that was applied, and `_reports/<date>-<host>-label.md` of the label step, which
// the run commits to the notes clone with its changes. No file, Git or network access of its own.

import { GLOBAL } from './scopes.mjs';
import { scanText } from './secret-scan.mjs';

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// An amount in USD as every line of the kit shows it: two decimals, or `unknown`.
export const usd = (value) => `USD ${value === null || value === undefined ? 'unknown' : value.toFixed(2)}`;

// A name shown in output or in a report; one that looks like a credential is not shown.
export function shown(text) {
  return scanText(String(text)).length > 0 ? '(file name withheld)' : String(text);
}

// `<label>/<file>` (as evaluate names it) shown relative to the scope: global/ keeps its prefix.
function display(label, file) {
  return label === GLOBAL ? `global/${file}` : file;
}

function splitLoc(entry) {
  const slash = entry.indexOf('/');
  return slash < 0 ? { label: 'notes', file: entry } : { label: entry.slice(0, slash), file: entry.slice(slash + 1) };
}

// The report of an Extract or Organize scope: the model's figures, what reached it (Extract), the
// index and note sizes of each folder before and after, the share of distinct terms kept, and the
// notes added (with their descriptions), changed, retired and not applied. `pairs` are the scope's
// folders (`notes`, and `global` in a project run), `snap` the snapshot, `ev` what evaluate said.
export function buildReport({ config, kind, scope, date, model, stopReason, costUsd, turns, denials, pairs, snap, ev, descriptions, conversation, repaired = 0 }) {
  const title = `${kind[0].toUpperCase()}${kind.slice(1)}`;
  const suffix = (label) => (label === GLOBAL ? ' (global/)' : '');
  const changed = (label) => ev.changes.some((c) => c.label === label);
  const labels = pairs.map((p) => p.label);
  const shownLabels = labels.filter((l) => l === 'notes' || changed(l));
  const lines = [`# ${title} ${scope} — ${date} on ${config.host}`, ''];
  lines.push(`- Model: ${model}; turns: ${turns ?? 'unknown'}; cost: ${usd(costUsd)}; stopped: ${stopReason}; denials: ${denials ?? 'unknown'}`);
  if (repaired > 0) lines.push(`- Repair: one repair run; the first check found ${repaired} problem(s)`);
  if (conversation) {
    lines.push(conversation.truncated
      ? `- Conversation text: cut to ${conversation.bytes} bytes; ${conversation.sessionsLeftOut} session(s) left out`
      : '- Conversation text: complete');
  }
  for (const l of shownLabels) {
    const { indexBefore: b, indexAfter: a } = ev.stats[l];
    lines.push(`- Index${suffix(l)}: ${b.lines} lines, ${b.bytes} bytes → ${a.lines} lines, ${a.bytes} bytes`);
  }
  for (const l of shownLabels) {
    lines.push(`- Notes not listed in the index${suffix(l)}: ${ev.stats[l].unlistedBefore} → ${ev.stats[l].unlistedAfter}`);
  }
  for (const l of labels.filter(changed)) {
    const s = ev.stats[l];
    lines.push(`- Notes${suffix(l)}: ${s.notesBytesBefore} bytes → ${s.notesBytesAfter} bytes; retired: ${s.retiredBytes} bytes`);
  }
  const r = ev.stats.retention;
  lines.push(`- Distinct terms kept: ${Math.floor(r.share * 100)}% (${r.termsKept} of ${r.termsBefore})`);
  const order = (c) => `${labels.indexOf(c.label)}\u0000${c.file}`;
  const sorted = [...ev.changes].sort((x, y) => byName(order(x), order(y)));
  let first = true;
  const section = (heading, items) => {
    if (items.length === 0) return;
    if (first) lines.push('');
    first = false;
    lines.push(`## ${heading}`, ...items);
  };
  section('Added', sorted.filter((c) => c.kind === 'add')
    .map((c) => `- ${shown(display(c.label, c.file))} — ${descriptions.get(`${c.label}/${c.file}`) ?? '(no description)'}`));
  section('Changed', sorted.filter((c) => c.kind === 'change').map((c) => `- ${shown(display(c.label, c.file))}`));
  section('Retired', sorted.filter((c) => c.kind === 'retire')
    .map((c) => `- ${shown(display(c.label, c.file))} → ${shown(display(c.target.label, c.target.file))}`));
  // Entries that are not notes at all are counted per folder, never named.
  const notNotes = labels.filter((l) => ev.ignoredEntries?.[l] > 0).map((l) => {
    const n = ev.ignoredEntries[l];
    const what = n === 1 ? '1 entry that is not a note file' : `${n} entries that are not note files`;
    return `- ${l === GLOBAL ? 'global/' : ''}(${what}): ignored`;
  });
  section('Not applied', [...ev.ignored.map((entry) => {
    const { label, file } = splitLoc(entry);
    const known = snap[label] && Object.hasOwn(snap[label], file);
    const why = known ? 'retiring a note is not part of an extract run' : 'a new file cannot be a retirement';
    return `- ${display(label, file)}: ${why}`;
  }), ...notNotes]);
  return `${lines.join('\n')}\n`;
}

// The head of the label step's report: its title, the model's figures and what the step did with
// the notes. The scope sections (labelReport in label-run.mjs) follow it.
export function labelReportHead({ date, host, model, requests, costUsd, touched, sent, exceptions, confirmed }) {
  return [
    `# Labels — ${date} on ${host}`, '',
    `- Model: ${model}; requests: ${requests}; cost: ${usd(costUsd)}`,
    `- Notes: ${touched} touched, ${sent} sent to the model, ${exceptions} with an exception, ${confirmed} recorded as they were`,
  ];
}
