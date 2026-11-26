// Cutting text to a UTF-8 byte length.

/** `text` cut to at most `max` UTF-8 bytes, on a character boundary. */
export function truncateUtf8(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length * 3 <= max) return { text, truncated: false };
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= max) return { text, truncated: false };
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--; // back off a continuation byte
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}
