// A stand-in for the edge: the sign-in routes of section 34.3, one API route
// and the socket of section 38, with the checks the real one makes on what
// the shell sends.
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

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
  accessLifeSeconds: number
  close(): Promise<void>
}

export async function startFakeEdge(): Promise<FakeEdge> {
  const principal = { org: 'org_test', subject: 'usr_test' }
  const codes = new Map<string, { challenge: string; redirectUri: string }>()
  let refresh: string | null = null
  let generation = 0
  const valid = (token: string | undefined) => token === `access.${generation}`

  const edge: FakeEdge = {
    url: '',
    principal,
    seen: [],
    apiHeaders: [],
    sockets: [],
    frames: [],
    accessLifeSeconds: 900,
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
    return JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, string>
  }

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', edge.url)
    edge.seen.push(`${req.method} ${url.pathname}`)
    const json = (status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json', 'set-cookie': 'leak=1' }).end(JSON.stringify(v))

    if (url.pathname === '/auth/app/authorize') {
      // The real edge shows the sign-in here; the fake one is always signed in.
      const q = url.searchParams
      const redirectUri = q.get('redirect_uri') ?? ''
      if (!/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri) || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) {
        return json(400, { error: 'invalid_request' })
      }
      const code = randomUUID()
      codes.set(code, { challenge: q.get('code_challenge')!, redirectUri })
      return res.writeHead(302, { location: `${redirectUri}?code=${code}&state=${encodeURIComponent(q.get('state')!)}` }).end()
    }
    if (url.pathname === '/auth/app/token' && req.method === 'POST') {
      const b = await body(req)
      if (b.grant_type === 'authorization_code') {
        const c = codes.get(b.code ?? '')
        codes.delete(b.code ?? '')
        const challenge = createHash('sha256').update(b.code_verifier ?? '').digest('base64url')
        if (!c || c.challenge !== challenge || c.redirectUri !== b.redirect_uri) return json(400, { error: 'invalid_grant' })
        refresh = `refresh.${randomUUID()}`
      } else if (b.grant_type !== 'refresh_token' || !refresh || b.refresh_token !== refresh) {
        return json(401, { error: 'invalid_grant' })
      }
      return json(200, { access_token: `access.${generation}`, expires_in: edge.accessLifeSeconds, refresh_token: refresh, device_id: 'dev_1', principal })
    }
    if (url.pathname.startsWith('/auth/app/devices/') && req.method === 'DELETE') {
      if (!valid(req.headers.authorization?.replace('Bearer ', ''))) return json(401, {})
      edge.revokeDevice()
      return res.writeHead(204).end()
    }
    if (url.pathname.startsWith('/api/')) {
      edge.apiHeaders.push(req.headers)
      if (!valid(req.headers.authorization?.replace('Bearer ', ''))) return json(401, { error: { code: 'unauthenticated' } })
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
      ws.on('message', (data) => {
        const f = JSON.parse(String(data)) as Record<string, unknown>
        edge.frames.push(f)
        if (f.t === 'hello') ws.send(JSON.stringify({ t: 'ready', connectionId: 'c1', protocol: 1, ...principal, expiresAt: Date.now() + 900_000, limits: {} }))
        if (f.t === 'sub') ws.send(JSON.stringify({ t: 'subd', stream: f.stream, head: 'f1.0' }))
        if (f.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }))
      })
    })
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  edge.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return edge
}
