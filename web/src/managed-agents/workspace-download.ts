/**
 * Streaming primitives for verified workspace downloads: an incremental
 * SHA-256 (crypto.subtle only digests whole buffers), CRC-32 for zip
 * entries, a store-only zip writer, and a byte sink that streams to disk
 * when the browser allows it and otherwise falls back to a Blob.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ])
  private readonly block = new Uint8Array(64)
  private readonly words = new Uint32Array(64)
  private blockLength = 0
  private totalLength = 0
  private finished = false

  update(chunk: Uint8Array) {
    if (this.finished) throw new Error('Sha256 already finalized')
    this.totalLength += chunk.length
    let offset = 0
    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, chunk.length)
      this.block.set(chunk.subarray(0, take), this.blockLength)
      this.blockLength += take
      offset = take
      if (this.blockLength < 64) return
      this.compress(this.block, 0)
      this.blockLength = 0
    }
    for (; offset + 64 <= chunk.length; offset += 64) {
      this.compress(chunk, offset)
    }
    if (offset < chunk.length) {
      this.block.set(chunk.subarray(offset))
      this.blockLength = chunk.length - offset
    }
  }

  /** Lowercase hex digest. */
  hex() {
    if (!this.finished) {
      const bitLength = this.totalLength * 8
      this.block[this.blockLength++] = 0x80
      if (this.blockLength > 56) {
        this.block.fill(0, this.blockLength)
        this.compress(this.block, 0)
        this.blockLength = 0
      }
      this.block.fill(0, this.blockLength)
      const view = new DataView(this.block.buffer)
      view.setUint32(56, Math.floor(bitLength / 0x100000000))
      view.setUint32(60, bitLength >>> 0)
      this.compress(this.block, 0)
      this.finished = true
    }
    return Array.from(this.state, (word) =>
      word.toString(16).padStart(8, '0'),
    ).join('')
  }

  private compress(data: Uint8Array, offset: number) {
    const w = this.words
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      w[i] =
        (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]
      const w2 = w[i - 2]
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let [a, b, c, d, e, f, g, h] = this.state
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    const s = this.state
    s[0] = (s[0] + a) | 0
    s[1] = (s[1] + b) | 0
    s[2] = (s[2] + c) | 0
    s[3] = (s[3] + d) | 0
    s[4] = (s[4] + e) | 0
    s[5] = (s[5] + f) | 0
    s[6] = (s[6] + g) | 0
    s[7] = (s[7] + h) | 0
  }
}

function rotr(x: number, n: number) {
  return (x >>> n) | (x << (32 - n))
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32Update(crc: number, chunk: Uint8Array) {
  let c = ~crc >>> 0
  for (let i = 0; i < chunk.length; i++) {
    c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)
  }
  return ~c >>> 0
}

/**
 * Most a memory-backed download may hold; beyond this the tab is likely to
 * die before the Blob is built, so callers fail fast instead.
 */
export const IN_MEMORY_DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024

/**
 * How long a finished fallback download keeps its Blob URL alive. The
 * anchor click only schedules the download, so the URL must outlive the
 * click briefly; browsers pick the Blob up well within this window.
 */
export const BLOB_URL_GRACE_MS = 5_000

interface LiveBlobUrl {
  url: string
  bytes: number
  timer: ReturnType<typeof setTimeout>
}

// Bytes held in memory by fallback sinks: buffered by open sinks plus the
// Blobs behind URLs still in their grace period. Shared across all sinks so
// overlapping or back-to-back downloads cannot stack up gigabytes.
let reservedFallbackBytes = 0
const liveBlobUrls = new Set<LiveBlobUrl>()

function releaseBlobUrl(live: LiveBlobUrl) {
  clearTimeout(live.timer)
  liveBlobUrls.delete(live)
  reservedFallbackBytes -= live.bytes
  URL.revokeObjectURL(live.url)
}

/** Where verified bytes go: the user's disk when possible, else memory. */
export interface ByteSink {
  /** Upper bound on total bytes this sink can take, or null if unbounded. */
  capacity: number | null
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
  /** Drop everything written so far; nothing is exposed to the user. */
  abort(reason?: unknown): Promise<void>
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string
  }) => Promise<SaveFileHandle>
}

interface SaveFileHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>
  getFile(): Promise<{ size: number }>
  /** Chromium-only; deletes the file the picker created or truncated. */
  remove?: () => Promise<void>
}

/**
 * Opens a sink for a download named `name`. Browsers with the File System
 * Access API stream straight to disk, which is what makes multi-hundred-MB
 * artifacts feasible; others buffer and save a Blob at the end.
 */
export async function openDownloadSink(name: string): Promise<ByteSink> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker
  if (picker) {
    let handle
    try {
      handle = await picker.call(window, { suggestedName: name })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new DownloadCancelled()
      }
      throw error
    }
    let writable: WritableStream<Uint8Array>
    try {
      writable = await handle.createWritable()
    } catch (error) {
      // The picker may already have truncated the file; drop the empty shell.
      try {
        if ((await handle.getFile()).size === 0) await handle.remove?.()
      } catch {
        // Best effort.
      }
      throw error
    }
    const writer = writable.getWriter()
    return {
      capacity: null,
      write: (chunk) => writer.write(chunk),
      close: () => writer.close(),
      // Chromium truncates the picked file to zero bytes as soon as the
      // picker resolves; after discarding the swap file, drop that empty
      // shell. A file that still has content (another engine preserved it)
      // is left alone.
      abort: async (reason) => {
        await writer.abort(reason)
        try {
          if ((await handle.getFile()).size === 0) await handle.remove?.()
        } catch {
          // Cleanup is best effort; the verification error is what matters.
        }
      },
    }
  }
  const chunks: Uint8Array<ArrayBuffer>[] = []
  const capacity = IN_MEMORY_DOWNLOAD_MAX_BYTES - reservedFallbackBytes
  let held = 0
  let settled = false
  const release = () => {
    if (settled) return
    settled = true
    reservedFallbackBytes -= held
    chunks.length = 0
  }
  return {
    capacity,
    write: (chunk) => {
      if (held + chunk.byteLength > capacity) {
        return Promise.reject(
          new DownloadTooLarge(held + chunk.byteLength, capacity),
        )
      }
      // Another sink may have consumed the shared budget since this one was
      // opened; the cap is on total memory, not per sink.
      if (
        reservedFallbackBytes + chunk.byteLength >
        IN_MEMORY_DOWNLOAD_MAX_BYTES
      ) {
        return Promise.reject(
          new DownloadTooLarge(
            held + chunk.byteLength,
            Math.max(
              0,
              IN_MEMORY_DOWNLOAD_MAX_BYTES - (reservedFallbackBytes - held),
            ),
          ),
        )
      }
      held += chunk.byteLength
      reservedFallbackBytes += chunk.byteLength
      chunks.push(chunk.slice())
      return Promise.resolve()
    },
    close: () => {
      if (settled) return Promise.resolve()
      const url = URL.createObjectURL(new Blob(chunks))
      const live: LiveBlobUrl = {
        url,
        bytes: held,
        timer: setTimeout(() => releaseBlobUrl(live), BLOB_URL_GRACE_MS),
      }
      liveBlobUrls.add(live)
      settled = true
      chunks.length = 0
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      anchor.click()
      return Promise.resolve()
    },
    abort: () => {
      release()
      return Promise.resolve()
    },
  }
}

export class DownloadTooLarge extends Error {
  constructor(bytes: number, capacity: number) {
    const mb = (n: number) => Math.ceil(n / (1024 * 1024))
    super(
      `This browser can only download up to ${mb(capacity)} MB right now (${mb(bytes)} MB requested). Use a Chromium-based browser to stream larger downloads to disk, wait a few seconds after a previous download, or download files individually.`,
    )
    this.name = 'DownloadTooLarge'
  }
}

/** Fails fast when `bytes` cannot fit the sink, before anything streams. */
export function assertSinkCapacity(sink: ByteSink, bytes: number) {
  if (sink.capacity !== null && bytes > sink.capacity) {
    throw new DownloadTooLarge(bytes, sink.capacity)
  }
}

export class DownloadCancelled extends Error {
  constructor() {
    super('Download cancelled')
    this.name = 'DownloadCancelled'
  }
}

/**
 * Upper bound on the bytes `ZipWriter` adds around the file contents of
 * `entries` (local headers, data descriptors, central directory with zip64
 * extras, end records), so capacity preflights cover the whole archive.
 */
export function zipOverheadBytes(entries: Array<{ path: string }>) {
  const encoder = new TextEncoder()
  let total = 22 + 76 // end of central directory (+ zip64 end + locator)
  for (const entry of entries) {
    const name = encoder.encode(entry.path).length
    total += 30 + name + 24 + 46 + name + 28
  }
  return total
}

interface ZipEntry {
  name: Uint8Array
  crc: number
  size: number
  offset: number
  dosTime: number
  dosDate: number
}

/**
 * Minimal streaming zip writer (method 0 / stored, data descriptors, zip64
 * where offsets or sizes need it). Entries are written as they arrive so
 * nothing is buffered beyond the current chunk.
 */
/**
 * Entry names are relative, forward-slash paths with no `.`/`..` segments,
 * so an extractor cannot be steered outside its target directory.
 */
export function safeZipEntryName(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/')
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        // eslint-disable-next-line no-control-regex
        /[\0-\x1f\x7f]/.test(segment) ||
        /^[A-Za-z]:/.test(segment),
    )
  ) {
    throw new Error(`Unsafe archive entry name: ${path}`)
  }
  return segments.join('/')
}

export class ZipWriter {
  private readonly entries: ZipEntry[] = []
  private offset = 0
  private current: ZipEntry | null = null

  constructor(private readonly sink: ByteSink) {}

  async beginEntry(path: string, modified?: Date) {
    if (this.current) throw new Error('Previous zip entry still open')
    const name = new TextEncoder().encode(safeZipEntryName(path))
    const [dosTime, dosDate] = dosDateTime(modified ?? new Date())
    const entry: ZipEntry = {
      name,
      crc: 0,
      size: 0,
      offset: this.offset,
      dosTime,
      dosDate,
    }
    const header = new Uint8Array(30 + name.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 45, true) // version needed: zip64-capable
    view.setUint16(6, 0x0808, true) // data descriptor + utf-8 names
    view.setUint16(8, 0, true) // stored
    view.setUint16(10, dosTime, true)
    view.setUint16(12, dosDate, true)
    // crc/sizes live in the data descriptor
    view.setUint16(26, name.length, true)
    view.setUint16(28, 0, true)
    header.set(name, 30)
    await this.emit(header)
    this.current = entry
  }

  async write(chunk: Uint8Array) {
    if (!this.current) throw new Error('No open zip entry')
    this.current.crc = crc32Update(this.current.crc, chunk)
    this.current.size += chunk.length
    await this.emit(chunk)
  }

  async endEntry() {
    const entry = this.current
    if (!entry) throw new Error('No open zip entry')
    const descriptor = new Uint8Array(24)
    const view = new DataView(descriptor.buffer)
    view.setUint32(0, 0x08074b50, true)
    view.setUint32(4, entry.crc, true)
    view.setBigUint64(8, BigInt(entry.size), true)
    view.setBigUint64(16, BigInt(entry.size), true)
    await this.emit(descriptor)
    this.entries.push(entry)
    this.current = null
  }

  async finish() {
    if (this.current) throw new Error('Zip entry still open')
    const centralStart = this.offset
    for (const entry of this.entries) {
      const zip64 = entry.size >= 0xffffffff || entry.offset >= 0xffffffff
      const extra = zip64 ? 28 : 0
      const record = new Uint8Array(46 + entry.name.length + extra)
      const view = new DataView(record.buffer)
      view.setUint32(0, 0x02014b50, true)
      view.setUint16(4, 45, true)
      view.setUint16(6, 45, true)
      view.setUint16(8, 0x0808, true)
      view.setUint16(10, 0, true)
      view.setUint16(12, entry.dosTime, true)
      view.setUint16(14, entry.dosDate, true)
      view.setUint32(16, entry.crc, true)
      view.setUint32(20, zip64 ? 0xffffffff : entry.size, true)
      view.setUint32(24, zip64 ? 0xffffffff : entry.size, true)
      view.setUint16(28, entry.name.length, true)
      view.setUint16(30, extra, true)
      view.setUint32(42, zip64 ? 0xffffffff : entry.offset, true)
      record.set(entry.name, 46)
      if (zip64) {
        const at = 46 + entry.name.length
        view.setUint16(at, 0x0001, true)
        view.setUint16(at + 2, 24, true)
        view.setBigUint64(at + 4, BigInt(entry.size), true)
        view.setBigUint64(at + 12, BigInt(entry.size), true)
        view.setBigUint64(at + 20, BigInt(entry.offset), true)
      }
      await this.emit(record)
    }
    const centralSize = this.offset - centralStart
    const count = this.entries.length
    const needZip64 =
      count >= 0xffff || centralSize >= 0xffffffff || centralStart >= 0xffffffff
    if (needZip64) {
      const zip64End = new Uint8Array(56 + 20)
      const view = new DataView(zip64End.buffer)
      view.setUint32(0, 0x06064b50, true)
      view.setBigUint64(4, 44n, true)
      view.setUint16(12, 45, true)
      view.setUint16(14, 45, true)
      view.setBigUint64(24, BigInt(count), true)
      view.setBigUint64(32, BigInt(count), true)
      view.setBigUint64(40, BigInt(centralSize), true)
      view.setBigUint64(48, BigInt(centralStart), true)
      view.setUint32(56, 0x07064b50, true)
      view.setBigUint64(64, BigInt(this.offset), true)
      view.setUint32(72, 1, true)
      await this.emit(zip64End)
    }
    const end = new Uint8Array(22)
    const view = new DataView(end.buffer)
    view.setUint32(0, 0x06054b50, true)
    view.setUint16(8, Math.min(count, 0xffff), true)
    view.setUint16(10, Math.min(count, 0xffff), true)
    view.setUint32(12, Math.min(centralSize, 0xffffffff), true)
    view.setUint32(16, Math.min(centralStart, 0xffffffff), true)
    await this.emit(end)
    await this.sink.close()
  }

  abort(reason?: unknown) {
    return this.sink.abort(reason)
  }

  private async emit(bytes: Uint8Array) {
    await this.sink.write(bytes)
    this.offset += bytes.length
  }
}

function dosDateTime(date: Date): [number, number] {
  const year = Math.max(1980, date.getFullYear())
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    (date.getSeconds() >> 1)
  const day =
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return [time, day]
}
