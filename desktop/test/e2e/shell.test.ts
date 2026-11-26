// The shell end to end, against the fake edge: sign-in through the "system
// browser", the placeholder page on oc://app/ exercising the bridge, the API
// proxy and its gate, the socket relay, the fence. Needs a display (xvfb-run
// on Linux).
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { startFakeEdge, type FakeEdge } from '../fake-edge'

let edge: FakeEdge
let app: ElectronApplication
let page: Page
let userData: string

const launch = async () => {
  app = await electron.launch({
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, join(__dirname, '../..')],
    env: { ...process.env, OC_EDGE_URL: edge.url, OC_PLAIN_KEY_STORE: '1', OC_UI: 'placeholder' },
  })
  // The system browser: follow the authorize redirect to the app's loopback listener.
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { opened: string[] }
    g.opened = []
    shell.openExternal = async (url: string) => {
      g.opened.push(url)
      if (url.includes('/auth/app/authorize')) await fetch(url)
    }
  })
  const main = () => app.windows().find((w) => w.url().startsWith('oc://app/'))
  while (!main()) await new Promise((r) => setTimeout(r, 50))
  page = main()!
}
const log = () => page.locator('#log').textContent()
// Pressed from inside the page: after a refused navigation Playwright's own click waits for a load that never comes.
const press = (id: string) => page.evaluate((id) => document.getElementById(id)!.click(), id)

beforeAll(async () => {
  edge = await startFakeEdge()
  userData = mkdtempSync(join(tmpdir(), 'oc-desktop-'))
  await launch()
})
afterAll(async () => {
  await app?.close()
  await edge?.close()
  rmSync(userData, { recursive: true, force: true })
})

test('signed out: the sign-in page, and no principal', async () => {
  await page.waitForURL('oc://app/__shell/signin.html')
  expect(await page.evaluate(() => (window as any).oc.host.principal)).toBeNull()
  expect(await page.evaluate(() => typeof (window as any).require)).toBe('undefined')
})

test('sign-in through the browser loads the app with the principal', async () => {
  await press('go')
  await page.waitForURL('oc://app/')
  expect(await page.locator('#org').textContent()).toBe('org_test')
  expect(await page.locator('#subject').textContent()).toBe(edge.principal.subject)
  const opened = await app.evaluate(() => (globalThis as any).opened as string[])
  expect(opened[0]).toMatch(/\/auth\/app\/authorize\?response_type=code&redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fcallback&code_challenge=/)
  // The refresh token is on disk, sealed.
  expect(readdirSync(userData)).toContain('credential.bin')
})

test('the socket: opened by the main process with the token in the subprotocol, frames relayed', async () => {
  await expect.poll(log).toContain('"t":"ready"')
  await expect.poll(log).toContain('"t":"subd","stream":"feed"')
  expect(edge.seen).toContain('UPGRADE /api/managed-agents/computer/live')
  await press('ping')
  await expect.poll(log).toContain('"t":"pong"')
  // A pushed feed frame reaches the window that watches the feed.
  edge.sockets[0]!.send(JSON.stringify({ t: 'feed', from: 'f1.0', to: 'f1.1', rows: [], gone: [] }))
  await expect.poll(log).toContain('"to":"f1.1"')
})

test('the API: proxied with the token, which no page sees', async () => {
  await press('feed')
  await expect.poll(log).toContain('feed 200')
  const h = edge.apiHeaders.at(-1)!
  expect(h.authorization).toBe(`Bearer ${edge.token(0)}`)
  expect(h.cookie).toBeUndefined()
  // The reply's cookie does not reach the page.
  expect(await page.evaluate(() => document.cookie)).toBe('')
})

test('an expired access token is refreshed and the request retried', async () => {
  edge.revokeAccess()
  await press('feed')
  await expect.poll(async () => ((await log()) ?? '').split('feed 200').length).toBe(3)
  expect(edge.apiHeaders.at(-1)!.authorization).toBe(`Bearer ${edge.token(1)}`)
})

test('the content security policy holds: no inline script, no foreign connection', async () => {
  const r = await page.evaluate(async () => {
    const s = document.createElement('script')
    s.textContent = 'window.__inline = 1'
    document.body.append(s)
    const foreign = await fetch('https://example.com/').then(
      () => 'allowed',
      () => 'blocked',
    )
    return { inline: (window as any).__inline ?? null, foreign }
  })
  expect(r).toEqual({ inline: null, foreign: 'blocked' })
})

test('navigation is fenced, and a new window goes to the system browser', async () => {
  await page.evaluate(() => void setTimeout(() => (location.href = 'https://example.com/'), 0))
  await page.evaluate(() => void window.open('https://example.org/x'))
  await press('external')
  await expect.poll(() => app.evaluate(() => (globalThis as any).opened as string[])).toContain('https://opencomputer.dev')
  const opened = await app.evaluate(() => (globalThis as any).opened as string[])
  expect(opened).toContain('https://example.org/x')
  expect(page.url()).toBe('oc://app/')
  expect(app.windows().length).toBe(1)
})

test('backup, badge and a deep link', async () => {
  await press('backup')
  await expect.poll(log).toContain('backup.data "draft at ')
  await press('badge')
  if (process.platform === 'darwin') await expect.poll(() => app.evaluate(({ app }) => app.getBadgeCount())).toBe(3)

  await app.evaluate(({ app }) => {
    app.emit('open-url', { preventDefault() {} }, 'opencomputer://thread/cs_0123456789ABCDEF?ask=ak_0123456789AB')
    app.emit('open-url', { preventDefault() {} }, 'opencomputer://thread/cs_0123456789ABCDEF?code=stolen')
  })
  await expect.poll(log).toContain('open {"threadId":"cs_0123456789ABCDEF","askId":"ak_0123456789AB"}')
  expect(await log()).not.toContain('stolen')
})

test('a relaunch is signed in from the stored refresh token and reopens where it was', async () => {
  await press('location')
  await app.close()
  await launch()
  // One document: the place is told to the page once it listens, not put in the URL.
  await page.waitForURL('oc://app/')
  await expect.poll(log).toContain('open {"threadId":"cs_0000000000000000"}')
  expect(await page.locator('#org').textContent()).toBe('org_test')
})

test('a revoked device: signed out, the sign-in page, the credential gone', async () => {
  edge.revokeDevice()
  await press('feed')
  await page.waitForURL('oc://app/__shell/signin.html')
  expect(readdirSync(userData)).not.toContain('credential.bin')
  expect(readdirSync(userData)).not.toContain('backup')
})
