// Which UI bundle the app serves (spec section 24.1, "Updates"). The built-in
// copy inside the app is the fallback. A copy fetched from the edge is code
// with the token's reach, so it is used only if, at every launch, its
// manifest's signature verifies against the key compiled into the app, every
// file matches the manifest's hash, and its version is not lower than the
// last one used.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'

export type Manifest = { version: number; files: Record<string, string> }

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

export function parseManifest(bytes: Buffer, sig: Buffer, keyPem: string): Manifest | null {
  if (!keyPem) return null
  try {
    if (!verify(null, bytes, createPublicKey(keyPem), sig)) return null
    const m = JSON.parse(bytes.toString('utf8')) as Manifest
    if (!Number.isSafeInteger(m.version) || m.version < 0 || typeof m.files !== 'object' || !m.files['index.html']) return null
    for (const [path, hash] of Object.entries(m.files)) {
      const n = normalize(path)
      if (n !== path || path.startsWith('/') || path.split(/[\\/]/).includes('..') || !/^[0-9a-f]{64}$/.test(hash)) return null
    }
    return m
  } catch {
    return null
  }
}

/** The verified manifest of the bundle in `dir`, or null if anything about it does not hold. */
export function verifyBundle(dir: string, keyPem: string, minVersion: number): Manifest | null {
  try {
    const m = parseManifest(readFileSync(join(dir, 'manifest.json')), readFileSync(join(dir, 'manifest.sig')), keyPem)
    if (!m || m.version < minVersion) return null
    for (const [path, hash] of Object.entries(m.files)) {
      if (sha256(readFileSync(join(dir, path))) !== hash) return null
    }
    return m
  } catch {
    return null
  }
}

type State = { last: number; current: string | null }

function readState(root: string): State {
  try {
    return JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')) as State
  } catch {
    return { last: 0, current: null }
  }
}

/**
 * The directory to serve this launch: the fetched bundle under `root` if it
 * verifies and is newer than the built-in one, else `builtin`.
 */
export function chooseBundle(root: string, builtin: string, builtinVersion: number, keyPem: string): { dir: string; version: number; fetched: boolean } {
  const state = readState(root)
  if (state.current) {
    const dir = join(root, state.current)
    const m = verifyBundle(dir, keyPem, Math.max(state.last, builtinVersion))
    if (m) {
      if (m.version !== state.last) writeFileSync(join(root, 'state.json'), JSON.stringify({ ...state, last: m.version }))
      return { dir, version: m.version, fetched: true }
    }
  }
  return { dir: builtin, version: builtinVersion, fetched: false }
}

/** The built-in bundle's version: its manifest's, unverified (the app's own signature covers it), or 0. */
export function builtinVersion(builtin: string): number {
  try {
    const v = (JSON.parse(readFileSync(join(builtin, 'manifest.json'), 'utf8')) as Manifest).version
    return Number.isSafeInteger(v) ? v : 0
  } catch {
    return 0
  }
}

/**
 * Fetch a newer bundle from the edge into `root`, to be used at next launch.
 * Nothing is written as current unless the whole of it verified.
 */
export async function fetchBundle(o: { root: string; base: string; keyPem: string; newerThan: number; fetch: typeof fetch }): Promise<number | null> {
  if (!o.keyPem) return null
  const get = async (path: string) => {
    const res = await o.fetch(`${o.base}/${path}`, { redirect: 'error' })
    if (!res.ok) throw new Error(`${path}: ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }
  const bytes = await get('manifest.json')
  const sig = await get('manifest.sig')
  const m = parseManifest(bytes, sig, o.keyPem)
  if (!m || m.version <= o.newerThan) return null
  const name = `v${m.version}`
  const tmp = join(o.root, `${name}.tmp`)
  rmSync(tmp, { recursive: true, force: true })
  for (const [path, hash] of Object.entries(m.files)) {
    const data = await get(path.split(sep).join('/'))
    if (sha256(data) !== hash) throw new Error(`${path}: hash mismatch`)
    mkdirSync(dirname(join(tmp, path)), { recursive: true })
    writeFileSync(join(tmp, path), data)
  }
  writeFileSync(join(tmp, 'manifest.json'), bytes)
  writeFileSync(join(tmp, 'manifest.sig'), sig)
  const dir = join(o.root, name)
  rmSync(dir, { recursive: true, force: true })
  renameSync(tmp, dir)
  const state = readState(o.root)
  const old = state.current
  writeFileSync(join(o.root, 'state.json'), JSON.stringify({ ...state, current: name }))
  if (old && old !== name && existsSync(join(o.root, old))) rmSync(join(o.root, old), { recursive: true, force: true })
  return m.version
}
