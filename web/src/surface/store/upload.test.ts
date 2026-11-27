import { describe, expect, it } from 'vitest'
import { safeNames, tar, uploadName } from './upload'

// What the host's tar check reads: name, size, checksum, type, then the body.
async function entries(b: Blob) {
  const buf = new Uint8Array(await b.arrayBuffer())
  const text = (from: number, len: number) => new TextDecoder().decode(buf.subarray(from, from + len)).replace(/\0.*$/s, '')
  const out: { name: string; body: string; checksumOk: boolean; type: string }[] = []
  let at = 0
  while (at < buf.length && buf[at] !== 0) {
    const size = Number.parseInt(text(at + 124, 12), 8)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : buf[at + i]
    out.push({
      name: text(at, 100),
      type: text(at + 156, 1),
      checksumOk: sum === Number.parseInt(text(at + 148, 8), 8),
      body: text(at + 512, size),
    })
    at += 512 + Math.ceil(size / 512) * 512
  }
  return { out, size: buf.length }
}

describe('tar', () => {
  it('packs each file as a regular ustar entry, padded to blocks, with the end marker', async () => {
    const t = tar([new File(['hello'], 'a.txt'), new File(['x'.repeat(600)], 'b.log')])
    const { out, size } = await entries(t)
    expect(out.map((e) => [e.name, e.type, e.checksumOk, e.body.length])).toEqual([
      ['a.txt', '0', true, 5],
      ['b.log', '0', true, 600],
    ])
    expect(out[0].body).toBe('hello')
    expect(size).toBe(512 + 512 + 512 + 1024 + 1024)
  })
})

describe('safeNames', () => {
  it('keeps names inside the upload and unique', () => {
    expect(safeNames(['image.png', 'image.png', 'Image.PNG', '../../etc/passwd', '.env', 'résumé (1).pdf', ''])).toEqual([
      'image.png',
      'image-2.png',
      'Image-3.PNG',
      '_.._etc_passwd',
      'env',
      'resume (1).pdf',
      'file',
    ])
  })

  it('shortens long names to 100 bytes and keeps the extension', () => {
    const [n] = safeNames([`${'a'.repeat(300)}.json`])
    expect(n).toHaveLength(100)
    expect(n.endsWith('.json')).toBe(true)
  })
})

describe('uploadName', () => {
  it('is a name the upload route takes', () => {
    const n = uploadName(new Date(2026, 10, 27, 15, 30), () => 0)
    expect(n).toBe('upload-2026-11-27-1530-aaaa')
    expect(n).toMatch(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/)
  })
})
