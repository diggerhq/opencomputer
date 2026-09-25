// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BLOB_URL_GRACE_MS,
  DownloadTooLarge,
  IN_MEMORY_DOWNLOAD_MAX_BYTES,
  Sha256,
  ZipWriter,
  safeZipEntryName,
  assertSinkCapacity,
  crc32Update,
  openDownloadSink,
  zipOverheadBytes,
  type ByteSink,
} from './workspace-download'

async function subtleHex(bytes: Uint8Array<ArrayBuffer>) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('')
}

function memorySink() {
  const chunks: Uint8Array[] = []
  let closed = false
  let aborted = false
  const sink: ByteSink = {
    capacity: null,
    write: (chunk) => {
      chunks.push(chunk.slice())
      return Promise.resolve()
    },
    close: () => {
      closed = true
      return Promise.resolve()
    },
    abort: () => {
      aborted = true
      chunks.length = 0
      return Promise.resolve()
    },
  }
  return {
    sink,
    bytes: () => {
      const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
      let at = 0
      for (const c of chunks) {
        out.set(c, at)
        at += c.length
      }
      return out
    },
    closed: () => closed,
    aborted: () => aborted,
  }
}

describe('Sha256', () => {
  it('matches known vectors', () => {
    expect(new Sha256().hex()).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    const abc = new Sha256()
    abc.update(new TextEncoder().encode('abc'))
    expect(abc.hex()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('agrees with crypto.subtle regardless of chunk boundaries', async () => {
    const data = new Uint8Array(200_003)
    for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff
    const expected = await subtleHex(data)
    for (const step of [1, 3, 55, 64, 65, 1000, 65_536]) {
      const hash = new Sha256()
      for (let at = 0; at < data.length; at += step) {
        hash.update(data.subarray(at, at + step))
      }
      expect(hash.hex(), `chunk ${step}`).toBe(expected)
    }
  })
})

describe('crc32Update', () => {
  it('matches the standard check value', () => {
    expect(
      crc32Update(0, new TextEncoder().encode('123456789')).toString(16),
    ).toBe('cbf43926')
    const a = crc32Update(0, new TextEncoder().encode('12345'))
    expect(crc32Update(a, new TextEncoder().encode('6789')).toString(16)).toBe(
      'cbf43926',
    )
  })
})

describe('assertSinkCapacity', () => {
  it('rejects oversized downloads for bounded sinks only', () => {
    const bounded = {
      ...memorySink().sink,
      capacity: IN_MEMORY_DOWNLOAD_MAX_BYTES,
    }
    expect(() =>
      assertSinkCapacity(bounded, IN_MEMORY_DOWNLOAD_MAX_BYTES),
    ).not.toThrow()
    expect(() =>
      assertSinkCapacity(bounded, IN_MEMORY_DOWNLOAD_MAX_BYTES + 1),
    ).toThrow(DownloadTooLarge)
    expect(() =>
      assertSinkCapacity(memorySink().sink, Number.MAX_SAFE_INTEGER),
    ).not.toThrow()
  })
})

describe('openDownloadSink fallback', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('counts live Blob URLs against the budget and releases them later', async () => {
    vi.useFakeTimers()
    const revoked: string[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:x')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      revoked.push(url)
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    const first = await openDownloadSink('a.bin')
    expect(first.capacity).toBe(IN_MEMORY_DOWNLOAD_MAX_BYTES)
    await first.write(new Uint8Array(1000))
    await first.close()
    expect(revoked).toEqual([])

    const second = await openDownloadSink('b.bin')
    expect(second.capacity).toBe(IN_MEMORY_DOWNLOAD_MAX_BYTES - 1000)
    await expect(
      second.write(new Uint8Array(IN_MEMORY_DOWNLOAD_MAX_BYTES - 999)),
    ).rejects.toBeInstanceOf(DownloadTooLarge)
    await second.write(new Uint8Array(500))

    // An open sink's buffered bytes are reserved too.
    const overlapping = await openDownloadSink('c.bin')
    expect(overlapping.capacity).toBe(IN_MEMORY_DOWNLOAD_MAX_BYTES - 1500)
    await second.abort()
    expect((await openDownloadSink('d.bin')).capacity).toBe(
      IN_MEMORY_DOWNLOAD_MAX_BYTES - 1000,
    )

    vi.advanceTimersByTime(BLOB_URL_GRACE_MS)
    expect(revoked).toEqual(['blob:x'])
    const third = await openDownloadSink('e.bin')
    expect(third.capacity).toBe(IN_MEMORY_DOWNLOAD_MAX_BYTES)
  })

  it('enforces the shared budget across sinks opened concurrently', async () => {
    const a = await openDownloadSink('a.bin')
    const b = await openDownloadSink('b.bin')
    expect(a.capacity).toBe(IN_MEMORY_DOWNLOAD_MAX_BYTES)
    expect(b.capacity).toBe(IN_MEMORY_DOWNLOAD_MAX_BYTES)
    const half = IN_MEMORY_DOWNLOAD_MAX_BYTES / 2
    await a.write(new Uint8Array(half))
    await b.write(new Uint8Array(half))
    // Each sink is within its own snapshot, but together they are full.
    await expect(a.write(new Uint8Array(1))).rejects.toBeInstanceOf(
      DownloadTooLarge,
    )
    await a.abort()
    await b.abort()
  })
})

describe('safeZipEntryName', () => {
  it('keeps relative paths and rejects escapes', () => {
    expect(safeZipEntryName('evidence/http 1.har')).toBe('evidence/http 1.har')
    for (const bad of ['../x', '/etc/passwd', 'a//b', './a', 'C:/x', 'a\u0000b']) {
      expect(() => safeZipEntryName(bad)).toThrow(/Unsafe archive entry/)
    }
  })
})

describe('zipOverheadBytes', () => {
  it('is at least what ZipWriter actually emits', async () => {
    const entries = [
      { path: 'a.txt', size: 3 },
      { path: 'nested/dir/ünïcode.bin', size: 5 },
    ]
    const mem = memorySink()
    const zip = new ZipWriter(mem.sink)
    for (const entry of entries) {
      await zip.beginEntry(entry.path)
      await zip.write(new Uint8Array(entry.size))
      await zip.endEntry()
    }
    await zip.finish()
    const content = entries.reduce((sum, entry) => sum + entry.size, 0)
    expect(mem.bytes().length - content).toBeLessThanOrEqual(
      zipOverheadBytes(entries),
    )
  })
})

describe('ZipWriter', () => {
  it('writes a stored archive with a readable central directory', async () => {
    const mem = memorySink()
    const zip = new ZipWriter(mem.sink)
    const encoder = new TextEncoder()
    await zip.beginEntry('a/report.txt', new Date(2026, 0, 2, 3, 4, 6))
    await zip.write(encoder.encode('hello '))
    await zip.write(encoder.encode('world'))
    await zip.endEntry()
    await zip.beginEntry('empty.bin')
    await zip.endEntry()
    await zip.finish()
    expect(mem.closed()).toBe(true)

    const bytes = mem.bytes()
    const view = new DataView(bytes.buffer)
    // local header + name + data + descriptor
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    const nameLength = view.getUint16(26, true)
    expect(new TextDecoder().decode(bytes.subarray(30, 30 + nameLength))).toBe(
      'a/report.txt',
    )
    const dataStart = 30 + nameLength
    expect(
      new TextDecoder().decode(bytes.subarray(dataStart, dataStart + 11)),
    ).toBe('hello world')
    const descriptor = dataStart + 11
    expect(view.getUint32(descriptor, true)).toBe(0x08074b50)
    expect(view.getUint32(descriptor + 4, true)).toBe(
      crc32Update(0, encoder.encode('hello world')),
    )
    expect(view.getBigUint64(descriptor + 8, true)).toBe(11n)

    // end of central directory
    const eocd = bytes.length - 22
    expect(view.getUint32(eocd, true)).toBe(0x06054b50)
    expect(view.getUint16(10 + eocd, true)).toBe(2)
    const centralStart = view.getUint32(eocd + 16, true)
    expect(view.getUint32(centralStart, true)).toBe(0x02014b50)
    expect(view.getUint32(centralStart + 20, true)).toBe(11)
    expect(view.getUint32(centralStart + 42, true)).toBe(0)
  })

  it('discards everything on abort', async () => {
    const mem = memorySink()
    const zip = new ZipWriter(mem.sink)
    await zip.beginEntry('x')
    await zip.write(new Uint8Array([1, 2, 3]))
    await zip.abort(new Error('mismatch'))
    expect(mem.aborted()).toBe(true)
    expect(mem.bytes().length).toBe(0)
    expect(mem.closed()).toBe(false)
  })
})
