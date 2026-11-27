// Files attached in a composer, packed as the tar archive the workspace upload
// takes (`PUT /sessions/{id}/workspace/archive`, opc docs api/http/workspace.mdx),
// the same route `opc push` uses: each message's files go to their own
// directory beside the repositories, and the session's next turn begins with a
// note that they arrived.
//
// Invariants:
// - Plain ustar, one regular file per attachment, no directories or links.
// - Names are made safe (no `/`, no leading `.`, ASCII), at most 100 bytes,
//   and unique within one upload; the extension is kept.
// - The bytes stay in their Blobs: packing copies nothing but the headers.

/** The host's limit per upload (`too_large` beyond it). */
export const MAX_UPLOAD_BYTES = 1024 ** 3

const BLOCK = 512
const NAME_MAX = 100

/** The upload's directory: `upload-2026-11-27-1530-k3x9`, readable and unique. */
export function uploadName(at: Date, random = Math.random): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const day = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
  const tag = Array.from({ length: 4 }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(random() * 32)]).join('')
  return `upload-${day}-${p(at.getHours())}${p(at.getMinutes())}-${tag}`
}

function safeName(name: string): string {
  let s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._ ()+-]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
  if (!s) s = 'file'
  if (s.length > NAME_MAX) {
    const dot = s.lastIndexOf('.')
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : ''
    s = s.slice(0, NAME_MAX - ext.length) + ext
  }
  return s
}

/** Each name made safe, and a repeat numbered (`image.png`, `image-2.png`). */
export function safeNames(names: readonly string[]): string[] {
  const taken = new Set<string>()
  return names.map((n) => {
    const base = safeName(n)
    let out = base
    for (let i = 2; taken.has(out.toLowerCase()); i++) {
      const dot = base.lastIndexOf('.')
      const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, '']
      const suffix = `-${i}`
      out = stem.slice(0, NAME_MAX - ext.length - suffix.length) + suffix + ext
    }
    taken.add(out.toLowerCase())
    return out
  })
}

function header(name: string, size: number, mtime: number): Uint8Array<ArrayBuffer> {
  const h = new Uint8Array(BLOCK)
  const put = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) h[at + i] = s.charCodeAt(i)
  }
  const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, '0')
  put(0, name)
  put(100, octal(0o644, 8))
  put(108, octal(0, 8))
  put(116, octal(0, 8))
  put(124, octal(size, 12))
  put(136, octal(Math.floor(mtime / 1000), 12))
  put(148, '        ')
  put(156, '0')
  put(257, 'ustar\u000000')
  let sum = 0
  for (const b of h) sum += b
  put(148, `${octal(sum, 7)}\u0000 `)
  return h
}

/** The files as one tar archive, in the order given, named by `safeNames`. */
export function tar(files: readonly File[]): Blob {
  const names = safeNames(files.map((f) => f.name))
  const parts: BlobPart[] = []
  files.forEach((f, i) => {
    parts.push(header(names[i], f.size, f.lastModified || Date.now()), f)
    const pad = (BLOCK - (f.size % BLOCK)) % BLOCK
    if (pad) parts.push(new Uint8Array(pad))
  })
  parts.push(new Uint8Array(BLOCK * 2))
  return new Blob(parts, { type: 'application/x-tar' })
}
