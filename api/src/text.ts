// Lower-cases text without changing its UTF-16 length, so an offset found in the
// folded text is valid in the original. Characters whose lower case has a
// different length (for example U+0130) are kept as they are.
export function foldCase(text: string): string {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

export function cutToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  // Largest prefix that fits and does not split a multi-byte character.
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  const fit = buf.subarray(0, end).toString('utf8');
  // Drop the CR of a CRLF pair whose LF is the cut.
  const dropCr = (s: string) => (s.endsWith('\r') ? s.slice(0, -1) : s);
  // The cut already falls on a line boundary when the next byte starts a new line.
  if (buf[end] === 0x0a) return { text: dropCr(fit), truncated: true };
  const lastNewline = fit.lastIndexOf('\n');
  return { text: lastNewline >= 0 ? dropCr(fit.slice(0, lastNewline)) : fit, truncated: true };
}
