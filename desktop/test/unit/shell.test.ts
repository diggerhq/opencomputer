import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { chooseBundle, verifyBundle } from '../../src/main/bundle'
import { parseDeepLink } from '../../src/main/deeplink'
import { Router } from '../../src/main/router'
import { mayProxy } from '../../src/main/scheme'
import { reconnectDelay } from '../../src/main/socket'

describe('deep links: a closed set, ids by format, never text or a code', () => {
  test.each([
    ['opencomputer://thread/cs_0123456789ABCDEF', { threadId: 'cs_0123456789ABCDEF' }],
    ['opencomputer://thread/cs_0123456789ABCDEF?ask=ak_0123456789AB', { threadId: 'cs_0123456789ABCDEF', askId: 'ak_0123456789AB' }],
    ['opencomputer://track/trk_0123456789ABCDEF', { trackId: 'trk_0123456789ABCDEF' }],
    ['opencomputer://new', { new: true }],
  ])('%s', (link, target) => expect(parseDeepLink(link)).toEqual(target))

  test.each([
    'opencomputer://callback?code=abc',
    'opencomputer://new?text=rm%20-rf',
    'opencomputer://thread/cs_short',
    'opencomputer://thread/cs_0123456789ABCDEF/extra',
    'opencomputer://thread/cs_0123456789ABCDEF?ask=nope',
    'opencomputer://thread/cs_0123456789ABCDEF?ask=ak_0123456789AB&text=hi',
    'opencomputer://thread/../../etc',
    'https://thread/cs_0123456789ABCDEF',
    'not a url',
  ])('refused: %s', (link) => expect(parseDeepLink(link)).toBeNull())
})

describe('the router: one socket for every window', () => {
  test('the second hello is answered from the first ready, and frames go to the windows that watch', () => {
    const r = new Router<string>()
    expect(r.outgoing('a', { t: 'hello' })).toEqual({ forward: true })
    expect(r.incoming({ t: 'ready', connectionId: 'c' })).toEqual(['a'])
    expect(r.outgoing('b', { t: 'hello' })).toEqual({ forward: false, reply: { t: 'ready', connectionId: 'c' } })

    r.outgoing('a', { t: 'sub', stream: 'feed' })
    r.outgoing('a', { t: 'sub', stream: 'events:cs_1' })
    r.outgoing('b', { t: 'sub', stream: 'events:cs_1' })
    expect(r.incoming({ t: 'feed', rows: [] })).toEqual(['a'])
    expect(r.incoming({ t: 'events', session: 'cs_1' })).toEqual(['a', 'b'])
    expect(r.incoming({ t: 'delta', session: 'cs_1' })).toEqual([])
    expect(r.incoming({ t: 'behind', stream: 'feed' })).toEqual(['a'])

    // One window leaves a stream another still watches: the socket stays subscribed.
    expect(r.outgoing('a', { t: 'unsub', stream: 'events:cs_1' }).forward).toBe(false)
    expect(r.outgoing('b', { t: 'unsub', stream: 'events:cs_1' }).forward).toBe(true)
  })

  test('a closed window leaves behind the streams nobody else watches; a closed socket starts hello over', () => {
    const r = new Router<string>()
    r.outgoing('a', { t: 'hello' })
    r.setSubs('a', ['feed', 'events:cs_1'])
    r.setSubs('b', ['feed'])
    expect(r.remove('a')).toEqual(['events:cs_1'])
    r.closed()
    expect(r.outgoing('b', { t: 'hello' })).toEqual({ forward: true })
  })
})

describe('the API proxy gate (section 24.2)', () => {
  const req = (h: Record<string, string>) => new Request('https://x/api/y', { headers: h })
  test('a fetch from the app itself, and nothing else', () => {
    expect(mayProxy(req({ origin: 'oc://app', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' }))).toBe(true)
    expect(mayProxy(req({ origin: 'https://evil.example' }))).toBe(false)
    expect(mayProxy(req({ referer: 'https://evil.example/' }))).toBe(false)
    expect(mayProxy(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(mayProxy(req({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'image' }))).toBe(false)
    expect(mayProxy(req({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'document' }))).toBe(false)
  })
})

describe('a fetched UI bundle is used only if it verifies', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  const sha = (s: string) => createHash('sha256').update(s).digest('hex')
  function bundle(root: string, name: string, version: number, o: { tamper?: boolean; key?: typeof privateKey } = {}) {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    const manifest = Buffer.from(JSON.stringify({ version, files: { 'index.html': sha('<html>') } }))
    writeFileSync(join(dir, 'index.html'), o.tamper ? '<html><script>' : '<html>')
    writeFileSync(join(dir, 'manifest.json'), manifest)
    writeFileSync(join(dir, 'manifest.sig'), sign(null, manifest, o.key ?? privateKey))
    writeFileSync(join(root, 'state.json'), JSON.stringify({ last: 0, current: name }))
    return dir
  }
  const root = () => mkdtempSync(join(tmpdir(), 'oc-ui-'))

  test('signed, hashes match, newer than the built-in: used', () => {
    const r = root()
    const dir = bundle(r, 'v5', 5)
    expect(chooseBundle(r, '/builtin', 3, pem)).toEqual({ dir, version: 5, fetched: true })
  })
  test('a changed file, another key, no key, or an older version: the built-in', () => {
    const builtin = { dir: '/builtin', version: 3, fetched: false }
    let r = root()
    bundle(r, 'v5', 5, { tamper: true })
    expect(chooseBundle(r, '/builtin', 3, pem)).toEqual(builtin)
    r = root()
    bundle(r, 'v5', 5, { key: generateKeyPairSync('ed25519').privateKey })
    expect(chooseBundle(r, '/builtin', 3, pem)).toEqual(builtin)
    r = root()
    bundle(r, 'v5', 5)
    expect(chooseBundle(r, '/builtin', 3, '')).toEqual(builtin)
    r = root()
    bundle(r, 'v2', 2)
    expect(chooseBundle(r, '/builtin', 3, pem)).toEqual(builtin)
  })
  test('never lower than the last one used', () => {
    const r = root()
    bundle(r, 'v5', 5)
    chooseBundle(r, '/builtin', 0, pem)
    const dir = bundle(r, 'v4', 4)
    writeFileSync(join(r, 'state.json'), JSON.stringify({ last: 5, current: 'v4' }))
    expect(verifyBundle(dir, pem, 0)?.version).toBe(4)
    expect(chooseBundle(r, '/builtin', 0, pem).fetched).toBe(false)
  })
})

test('reconnect: 1 to 5 s at random, doubling to 60 s', () => {
  expect(reconnectDelay(0, 0)).toBe(1000)
  expect(reconnectDelay(0, 1)).toBe(5000)
  expect(reconnectDelay(2, 0.5)).toBe(12000)
  expect(reconnectDelay(10, 0.5)).toBe(60000)
})
