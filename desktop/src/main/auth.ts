// Sign-in and the token (spec sections 20, 24.1, 34.3). Authorization code
// with PKCE in the system browser, returning to a loopback listener that
// lives for that one sign-in (RFC 8252). The refresh token is stored through
// `seal`/`unseal` (Electron's safeStorage); the access token stays in this
// process's memory and is never given to a page.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Principal } from '../shared/bridge'

export type TokenReply = {
  access_token: string
  expires_in: number // seconds
  refresh_token?: string
  device_id?: string
  principal: Principal
}

type Stored = { refreshToken: string; deviceId: string | null; principal: Principal }

export type AuthDeps = {
  edge: string
  deviceName: string
  fetch: typeof fetch
  openExternal(url: string): void | Promise<void>
  /** The sealed credential's bytes on disk: read (null if none), write, delete (null). */
  load(): Buffer | null
  save(sealed: Buffer | null): void
  seal(plain: string): Buffer
  unseal(sealed: Buffer): string
  now?: () => number
}

const SIGN_IN_TIMEOUT_MS = 5 * 60_000
/** Refresh this long before the access token's expiry. */
const EARLY_MS = 60_000

const b64url = (b: Buffer) => b.toString('base64url')

export class Auth {
  private stored: Stored | null = null
  private access: { token: string; expiresAt: number } | null = null
  private refreshing: Promise<string | null> | null = null
  private signingIn: { server: Server; cancel(): void } | null = null
  private listeners = new Set<(p: Principal | null) => void>()
  private now: () => number

  constructor(private deps: AuthDeps) {
    this.now = deps.now ?? Date.now
    try {
      const sealed = deps.load()
      if (sealed) this.stored = JSON.parse(deps.unseal(sealed)) as Stored
    } catch {
      // Unreadable (another machine's key store, a damaged file): signed out.
      this.stored = null
    }
  }

  get principal(): Principal | null {
    return this.stored?.principal ?? null
  }

  /** Called with the principal at sign-in and with null when signed out or refused. */
  onChange(cb: (p: Principal | null) => void): void {
    this.listeners.add(cb)
  }

  /** A valid access token, refreshed if needed; null when signed out or the edge is unreachable. */
  async token(): Promise<string | null> {
    if (!this.stored) return null
    if (this.access && this.access.expiresAt - EARLY_MS > this.now()) return this.access.token
    return (this.refreshing ??= this.refresh().finally(() => (this.refreshing = null)))
  }

  /** Milliseconds until the access token should be renewed, or null without one. */
  renewIn(): number | null {
    return this.access ? Math.max(0, this.access.expiresAt - EARLY_MS - this.now()) : null
  }

  /** Drop the access token after the edge answered 401 with it, so the next call refreshes. */
  invalidate(token: string): void {
    if (this.access?.token === token) this.access = null
  }

  private async refresh(): Promise<string | null> {
    const stored = this.stored
    if (!stored) return null
    let res: Response
    try {
      res = await this.post({ grant_type: 'refresh_token', refresh_token: stored.refreshToken })
    } catch {
      return null // offline: stay signed in, the caller retries
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      // Revoked, or no longer a member (section 20).
      this.clear()
      return null
    }
    if (!res.ok) return null
    const reply = (await res.json()) as TokenReply
    if (this.stored !== stored) return null // signed out meanwhile
    if (reply.principal.org !== stored.principal.org || reply.principal.subject !== stored.principal.subject) {
      this.clear()
      return null
    }
    this.accept(reply, stored)
    return reply.access_token
  }

  private accept(reply: TokenReply, prior: Stored | null): void {
    this.access = { token: reply.access_token, expiresAt: this.now() + reply.expires_in * 1000 }
    const refreshToken = reply.refresh_token ?? prior?.refreshToken
    if (!refreshToken) throw new Error('the edge sent no refresh token')
    this.stored = { refreshToken, deviceId: reply.device_id ?? prior?.deviceId ?? null, principal: reply.principal }
    this.deps.save(this.deps.seal(JSON.stringify(this.stored)))
  }

  private post(body: object): Promise<Response> {
    return this.deps.fetch(`${this.deps.edge}/auth/app/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
    })
  }

  private clear(): void {
    const had = this.stored !== null
    this.stored = null
    this.access = null
    this.deps.save(null)
    if (had) for (const cb of this.listeners) cb(null)
  }

  /** Opens the system browser and resolves once the person has signed in there. */
  async signIn(): Promise<Principal> {
    this.signingIn?.cancel()
    const verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(16))

    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`

    const code = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in timed out')), SIGN_IN_TIMEOUT_MS)
      this.signingIn = {
        server,
        cancel: () => {
          clearTimeout(timer)
          reject(new Error('Sign-in was started again'))
        },
      }
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri)
        // Only a loopback address is a valid Host: a page on another origin
        // that resolves a name to 127.0.0.1 is not answered.
        if (req.method !== 'GET' || url.pathname !== '/callback' || req.headers.host !== new URL(redirectUri).host) {
          res.writeHead(404).end()
          return
        }
        const error = url.searchParams.get('error')
        const ok = !error && url.searchParams.get('state') === state && !!url.searchParams.get('code')
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        res.end(page(ok ? 'You are signed in' : 'Sign-in failed', ok ? 'You can close this tab and return to OpenComputer.' : 'Return to OpenComputer and try again.'))
        if (url.searchParams.get('state') !== state) return // not ours: keep waiting
        clearTimeout(timer)
        if (ok) resolve(url.searchParams.get('code')!)
        else reject(new Error(error === 'access_denied' ? 'Sign-in was cancelled' : 'Sign-in failed'))
      })
    })

    try {
      const authorize = new URL(`${this.deps.edge}/auth/app/authorize`)
      authorize.search = new URLSearchParams({
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        device_name: this.deps.deviceName,
      }).toString()
      await this.deps.openExternal(authorize.toString())
      const res = await this.post({ grant_type: 'authorization_code', code: await code, code_verifier: verifier, redirect_uri: redirectUri })
      if (!res.ok) throw new Error(`Sign-in failed (${res.status})`)
      const reply = (await res.json()) as TokenReply
      this.accept(reply, null)
      for (const cb of this.listeners) cb(reply.principal)
      return reply.principal
    } finally {
      if (this.signingIn?.server === server) this.signingIn = null
      server.close()
      server.closeAllConnections()
    }
  }

  /** Revokes this device at the edge (best effort) and forgets the credential. */
  async signOut(): Promise<void> {
    const stored = this.stored
    const token = stored?.deviceId ? await this.token() : null
    this.clear()
    if (!stored?.deviceId || !token) return
    try {
      await this.deps.fetch(`${this.deps.edge}/auth/app/devices/${encodeURIComponent(stored.deviceId)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      })
    } catch {
      // Offline: the device stays listed and can be revoked from the dashboard.
    }
  }
}

function page(title: string, line: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#222;background:#fafafa"><div style="text-align:center"><h1 style="font-size:20px">${title}</h1><p>${line}</p></div>`
}
