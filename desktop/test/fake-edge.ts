// A stand-in for the edge: the sign-in routes of section 34.3, one API route
// and the socket of section 38, with the checks the real one makes on what
// the shell sends.
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { createFakeServer, type FakeServer } from '../../sdks/typescript/src/computer/fake/index'

export type FakeEdge = {
  url: string
  principal: { org: string; subject: string }
  /** Every request seen, as `METHOD path`. */
  seen: string[]
  apiHeaders: Record<string, string | string[] | undefined>[]
  sockets: WebSocket[]
  frames: Record<string, unknown>[]
  /** Access tokens are valid until this is bumped. */
  revokeAccess(): void
  revokeDevice(): void
  /** The access token of a generation, shaped as the edge's: a JWT whose claims name the member. */
  token(generation: number): string
  accessLifeSeconds: number
  /** With `surface`: the SDK's fake server (sections 37 and 38) behind the API and the socket. */
  server: FakeServer | null
  close(): Promise<void>
}

export async function startFakeEdge(o: { surface?: boolean } = {}): Promise<FakeEdge> {
  // The subject is the member id of the token's `user_id`, as the edge maps it.
  const principal = { org: 'org_test', subject: 'usr_01jtesttesttesttesttesttes' }
  const claims = Buffer.from(JSON.stringify({ iss: 'opensandbox-app', org_id: 'org_test', user_id: 'user_01JTESTTESTTESTTESTTESTTES', dev: 'dev_1' })).toString('base64url')
  const tokenOf = (g: number) => `eyJ0.${claims}.g${g}`
  const codes = new Map<string, { challenge: string; redirectUri: string }>()
  let refresh: string | null = null
  let generation = 0
  const valid = (token: string | undefined) => token === tokenOf(generation)

  const edge: FakeEdge = {
    url: '',
    principal,
    seen: [],
    apiHeaders: [],
    sockets: [],
    frames: [],
    accessLifeSeconds: 900,
    server: null,
    token: tokenOf,
    revokeAccess: () => void generation++,
    revokeDevice: () => {
      refresh = null
      generation++
    },
    close: () => new Promise((r) => (wss.close(), server.closeAllConnections(), server.close(() => r()))),
  }

  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const text = Buffer.concat(chunks).toString()
    // The token route takes a form, as the edge does; the API takes JSON.
    if (req.headers['content-type'] === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(text))
    return JSON.parse(text || '{}') as Record<string, string>
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', edge.url)
    edge.seen.push(`${req.method} ${url.pathname}`)
    const json = (status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json', 'set-cookie': 'leak=1' }).end(JSON.stringify(v))

    if (url.pathname === '/auth/app/authorize') {
      // The real edge shows the sign-in here; the fake one is always signed in.
      const q = url.searchParams
      const redirectUri = q.get('redirect_uri') ?? ''
      if (!/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri) || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) {
        return json(400, { error: 'invalid_request' })
      }
      const code = randomUUID()
      codes.set(code, { challenge: q.get('code_challenge')!, redirectUri })
      return res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(q.get('state')!)}` }).end()
    }
    if (url.pathname === '/auth/app/token' && req.method === 'POST') {
      if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') return json(400, { error: 'invalid_request' })
      const b = await body(req)
      if (b.grant_type === 'authorization_code') {
        const c = codes.get(b.code ?? '')
        codes.delete(b.code ?? '')
        const challenge = createHash('sha256').update(b.code_verifier ?? '').digest('base64url')
        if (!c || c.challenge !== challenge || c.redirectUri !== b.redirect_uri) return json(400, { error: 'invalid_grant' })
      } else if (b.grant_type !== 'refresh_token' || !refresh || b.refresh_token !== refresh) {
        return json(400, { error: 'invalid_grant' })
      }
      // The refresh token rotates on every use.
      refresh = `ocr_${randomUUID()}`
      return json(200, { access_token: tokenOf(generation), token_type: 'Bearer', expires_in: edge.accessLifeSeconds, refresh_token: refresh, device_id: 'dev_1' })
    }
    if (url.pathname.startsWith('/auth/app/devices/') && req.method === 'DELETE') {
      if (!valid(req.headers.authorization?.replace('Bearer ', ''))) return json(401, {})
      edge.revokeDevice()
      return res.writeHead(204).end()
    }
    if (url.pathname.startsWith('/api/managed-agents/computer/')) {
      edge.apiHeaders.push(req.headers)
      if (!valid(req.headers.authorization?.replace('Bearer ', ''))) return json(401, { error: { code: 'unauthenticated' } })
      if (edge.server) {
        const init: RequestInit = { method: req.method, headers: req.headers as Record<string, string> }
        if (req.method !== 'GET' && req.method !== 'HEAD') init.body = JSON.stringify(await body(req))
        const r = await edge.server.fetch(url.pathname.slice('/api/managed-agents/computer'.length) + url.search, init)
        return res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' }).end(Buffer.from(await r.arrayBuffer()))
      }
      if (url.pathname.endsWith('/feed')) return json(200, { protocol: 1, rows: [], gone: [], to: 'f1.0', more: false, principal })
      if (url.pathname.endsWith('/echo')) return json(200, { got: await body(req) })
      return json(404, { error: { code: 'not_found' } })
    }
    res.writeHead(404).end()
  })

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('oc.live.v1') ? 'oc.live.v1' : false),
  })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', edge.url)
    edge.seen.push(`UPGRADE ${url.pathname}${url.search}`)
    const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim())
    const token = offered.find((p) => p.startsWith('oc.bearer.'))?.slice('oc.bearer.'.length)
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname !== '/api/managed-agents/computer/live' || !valid(token)) return ws.close(4001, 'unauthenticated')
      edge.sockets.push(ws)
      if (edge.server) {
        const channel = edge.server.connect()
        channel.onFrame((f) => ws.send(JSON.stringify(f)))
        ws.on('message', (data) => channel.send(JSON.parse(String(data))))
        ws.on('close', () => channel.close())
        return
      }
      ws.on('message', (data) => {
        const f = JSON.parse(String(data)) as Record<string, unknown>
        edge.frames.push(f)
        if (f.t === 'hello') ws.send(JSON.stringify({ t: 'ready', connectionId: 'c1', protocol: 1, ...principal, expiresAt: Date.now() + 900_000, limits: {} }))
        if (f.t === 'sub') ws.send(JSON.stringify({ t: 'subd', stream: f.stream, head: 'f1.0' }))
        if (f.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }))
      })
    })
  })

  if (o.surface) edge.server = createFakeServer({ principal, seed: 'demo' })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  edge.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return edge
}
