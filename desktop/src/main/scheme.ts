// The oc://app/ handler (spec sections 24.1, 24.2): serves the UI bundle and
// proxies oc://app/api/* to the edge with the access token attached. The
// token is added here, in the main process, and never reaches a page.
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { APP_HEADER, APP_ORIGIN } from '../shared/bridge'

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

export type SchemeDeps = {
  edge: string
  /** The UI bundle's directory, and the shell's own pages' (sign-in), served under /__shell/. */
  uiDir(): string
  shellDir: string
  signedIn(): boolean
  token(): Promise<string | null>
  invalidate(token: string): void
  fetch: typeof fetch
}

/** Request headers the proxy passes on. Everything else (cookies, origin, referer) stays behind. */
const PASS = /^(accept|accept-language|content-type|idempotency-key|if-match|if-none-match|x-oc-[a-z0-9-]+)$/
/** Reply headers a page must not see or that no longer describe the body. */
const DROP = /^(set-cookie|content-encoding|content-length|transfer-encoding|connection)$/

const json = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message, retryable: false } }), { status, headers: { 'content-type': 'application/json' } })

/** Whether a request may have the token attached (section 24.2). */
export function mayProxy(request: Request): boolean {
  if (request.headers.get(APP_HEADER) !== '1') return false
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== APP_ORIGIN) return false
  const referer = request.headers.get('referer')
  if (referer !== null && !referer.startsWith(`${APP_ORIGIN}/`)) return false
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin') return false
  return true
}

export function createHandler(deps: SchemeDeps): (request: Request) => Promise<Response> {
  async function proxy(request: Request, url: URL): Promise<Response> {
    if (!mayProxy(request)) return json(403, 'forbidden', 'This request may not use the API')
    const method = request.method.toUpperCase()
    const body = method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer())
    if (body?.length && !/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) {
      return json(415, 'unsupported_media_type', 'A body must be application/json')
    }
    const headers = new Headers()
    request.headers.forEach((v, k) => PASS.test(k) && k !== APP_HEADER && headers.set(k, v))

    for (let attempt = 0; ; attempt++) {
      const token = await deps.token()
      if (!token) return json(deps.signedIn() ? 503 : 401, deps.signedIn() ? 'offline' : 'signed_out', 'No access token')
      headers.set('authorization', `Bearer ${token}`)
      let res: Response
      try {
        // A long-poll or a streamed body passes through as a stream.
        res = await deps.fetch(deps.edge + url.pathname + url.search, { method, headers, body, redirect: 'error', signal: request.signal })
      } catch (e) {
        if (request.signal.aborted) throw e
        return json(503, 'offline', 'The edge could not be reached')
      }
      if (res.status === 401 && attempt === 0) {
        deps.invalidate(token)
        await res.body?.cancel()
        continue
      }
      const out = new Headers()
      res.headers.forEach((v, k) => !DROP.test(k) && out.set(k, v))
      return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers: out })
    }
  }

  async function file(dir: string, path: string, fallback: boolean): Promise<Response> {
    const rel = normalize(decodeURIComponent(path)).replace(/^[/\\]+/, '')
    if (rel.split(/[/\\]/).includes('..')) return new Response('Not found', { status: 404 })
    let name = rel === '' ? 'index.html' : rel
    let data: Buffer
    try {
      data = await readFile(join(dir, name))
    } catch {
      // A location of the surface (/thread/cs_…): the app's document.
      if (!fallback || extname(name)) return new Response('Not found', { status: 404 })
      name = 'index.html'
      data = await readFile(join(dir, name))
    }
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-cache',
      },
    })
  }

  return async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'app') return new Response('Not found', { status: 404 })
    if (url.pathname.startsWith('/api/')) return proxy(request, url)
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 })
    if (url.pathname.startsWith('/__shell/')) return file(deps.shellDir, url.pathname.slice('/__shell'.length), false)
    return file(deps.uiDir(), url.pathname, true)
  }
}
