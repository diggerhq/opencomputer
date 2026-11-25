// The surface's desktop bundle (web's `npm run build:desktop`) in the shell,
// against the SDK's fake server behind the fake edge: it loads on oc://app/,
// reads through the proxy and the relayed socket, and shows the demo's rows.
// Skipped when the bundle has not been built into ui/.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { startFakeEdge, type FakeEdge } from '../fake-edge'

const root = join(__dirname, '../..')
const built = existsSync(join(root, 'ui/index.html'))

let edge: FakeEdge
let app: ElectronApplication
let page: Page
let userData: string
const errors: string[] = []

beforeAll(async () => {
  if (!built) return
  edge = await startFakeEdge({ surface: true })
  userData = mkdtempSync(join(tmpdir(), 'oc-desktop-'))
  app = await electron.launch({
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`, root],
    env: { ...process.env, OC_EDGE_URL: edge.url, OC_PLAIN_KEY_STORE: '1' },
  })
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      if (url.includes('/auth/app/authorize')) await fetch(url)
    }
  })
  page = await app.firstWindow()
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.waitForURL('oc://app/__shell/signin.html')
  await page.evaluate(() => document.getElementById('go')!.click())
  await page.waitForURL('oc://app/')
})
afterAll(async () => {
  await app?.close()
  await edge?.close()
  if (userData) rmSync(userData, { recursive: true, force: true })
})

test.skipIf(!built)('the surface loads in the shell and shows the rows the edge has', async () => {
  await page.locator('.surface[data-platform="desktop"]').waitFor()
  const title = edge.server!.rows('track').find((k) => k.name)!.name!
  await page.getByText(title).first().waitFor()
  expect(edge.seen).toContain('UPGRADE /api/managed-agents/computer/live')
  expect(edge.seen.some((s) => s.startsWith('GET /api/managed-agents/computer/'))).toBe(true)
  // For a person to look at; some CI displays cannot capture.
  await page.screenshot({ path: join(root, 'test-results/surface.png') }).catch(() => {})
  expect(errors).toEqual([])
})
