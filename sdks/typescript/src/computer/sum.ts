// The feed's checksum (section 37.1): the XOR of the first 8 bytes of SHA-256(`<kind>|<id>|<version>`)
// over every `track`, `place` and `session` row, as 16 hex digits.

const KINDS = new Set(["track", "place", "session"]);

export async function checksum(rows: Iterable<{ kind: string; id: string; version: number }>): Promise<string> {
  const acc = new Uint8Array(8);
  const enc = new TextEncoder();
  const jobs: Promise<void>[] = [];
  for (const r of rows) {
    if (!KINDS.has(r.kind)) continue;
    jobs.push(
      crypto.subtle.digest("SHA-256", enc.encode(`${r.kind}|${r.id}|${r.version}`)).then((d) => {
        const b = new Uint8Array(d);
        for (let i = 0; i < 8; i++) acc[i] ^= b[i];
      }),
    );
  }
  await Promise.all(jobs);
  return Array.from(acc, (b) => b.toString(16).padStart(2, "0")).join("");
}
