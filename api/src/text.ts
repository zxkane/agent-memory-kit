export function cutToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  // Largest prefix that fits and does not split a multi-byte character.
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  const fit = buf.subarray(0, end).toString('utf8');
  // The cut already falls on a line boundary when the next byte starts a new line.
  if (buf[end] === 0x0a) return { text: fit, truncated: true };
  const lastNewline = fit.lastIndexOf('\n');
  return { text: lastNewline > 0 ? fit.slice(0, lastNewline) : fit, truncated: true };
}
