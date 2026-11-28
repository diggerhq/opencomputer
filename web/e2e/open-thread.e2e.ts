import { expect, test, type Page } from '@playwright/test'

// A thread opens at its end, and nobody sees it load (work 139). The demo
// host's long threads: `long` is 2,000 messages, `tools` ends in a turn of
// 2,000 tool events.

const SID = 'cs_0pmnvt9w0pba00an'
const ROW = '[data-conversation] [data-index]'

interface Frame {
  rows: number
  height: number
  // Distance from the end, in px.
  bottom: number
  filled: boolean
  // The last row's text and where it is.
  last: string
  lastTop: number
  reading: boolean
}

declare global {
  interface Window {
    frames139: Frame[]
  }
}

// What the conversation shows, on every frame.
async function record(page: Page) {
  await page.addInitScript(() => {
    window.frames139 = []
    const tick = () => {
      const el = document.querySelector('[data-conversation]')
      const rows = [...document.querySelectorAll<HTMLElement>('[data-conversation] [data-index]')]
      const last = rows.sort((a, b) => Number(b.dataset.index) - Number(a.dataset.index))[0]
      window.frames139.push({
        rows: rows.length,
        height: el?.scrollHeight ?? 0,
        bottom: el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : 0,
        filled: el ? el.scrollHeight > el.clientHeight : false,
        last: last?.textContent ?? '',
        lastTop: last ? Math.round(last.getBoundingClientRect().top) : 0,
        reading: !!document.querySelector('[data-reading]'),
      })
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

const frames = (page: Page) => page.evaluate(() => window.frames139.splice(0))

// The reads the demo host served, as their query strings.
const reads = (page: Page) =>
  page.evaluate(() =>
    performance
      .getEntriesByType('mark')
      .filter((m) => m.name.startsWith('demo:read'))
      .map((m) => m.name.slice('demo:read'.length)),
  )

async function open(page: Page, fake: 'long' | 'tools') {
  await record(page)
  await page.goto(`/computer/work/t/${SID}?fake=${fake}`)
  await page.waitForSelector(ROW)
  await page.waitForTimeout(1000)
}

test('a long thread opens by link in one read, drawn once, at its end', async ({ page }) => {
  await open(page, 'long')
  const drawn = (await frames(page)).filter((f) => f.rows > 0)
  expect(await reads(page)).toEqual(['?last=200'])
  // One drawing: every frame with content is the same one.
  // One drawing: from the first frame with content, the view is full, at
  // the end, and what it shows stays where it is.
  expect(new Set(drawn.map((f) => f.last)).size).toBe(1)
  for (const f of drawn) {
    expect(f.filled).toBe(true)
    expect(f.bottom).toBeLessThanOrEqual(1)
    expect(Math.abs(f.lastTop - drawn[0].lastTop)).toBeLessThanOrEqual(1)
  }
})

test('a thread ending in a very long turn opens at its end and stays there', async ({ page }) => {
  await open(page, 'tools')
  const drawn = (await frames(page)).filter((f) => f.rows > 0)
  // The first drawing waits for at most three pages before the window; what
  // lands later goes above, and the end does not move.
  expect((await reads(page)).length).toBeLessThanOrEqual(5)
  expect(new Set(drawn.map((f) => f.last)).size).toBe(1)
  for (const f of drawn) expect(f.bottom).toBeLessThanOrEqual(1)
})

test('a thread seen before opens from memory, with no loading state', async ({ page }) => {
  await open(page, 'long')
  await page.getByRole('button', { name: 'New' }).first().click()
  await expect(page.locator(ROW)).toHaveCount(0)
  const before = (await reads(page)).length
  await frames(page)
  await page.locator(`[data-nav="thread:${SID}"]`).first().click()
  await page.waitForSelector(ROW)
  await page.waitForTimeout(500)
  const seen = await frames(page)
  expect(seen.some((f) => f.reading)).toBe(false)
  for (const f of seen.filter((f) => f.rows > 0)) expect(f.bottom).toBeLessThanOrEqual(1)
  expect((await reads(page)).length).toBe(before)
})

test('scrolling up reads earlier pages without moving what is read', async ({ page }) => {
  await open(page, 'long')
  let pages = (await reads(page)).length
  let landed = 0
  for (let i = 0; landed < 3 && i < 4000; i++) {
    // Scrolled in steps, not by the wheel: WebKit animates a wheel scroll, and
    // the view must be still for a move to be the page's doing.
    await page.locator('[data-conversation]').evaluate((el) => (el.scrollTop -= 240))
    await page.waitForTimeout(16)
    if ((await reads(page)).length === pages) continue
    pages++
    // A page was asked for: watch a row in the middle of the view while it lands.
    const moved = await page.evaluate(async () => {
      const all = () => [...document.querySelectorAll<HTMLElement>('[data-conversation] [data-index]')]
      const el = document.querySelector('[data-conversation]')!
      const mid = el.getBoundingClientRect().top + el.clientHeight / 2
      const text = all().find((r) => r.getBoundingClientRect().bottom > mid)!.textContent
      const top = () => all().find((r) => r.textContent === text)?.getBoundingClientRect().top
      const from = top()!
      let max = 0
      const t0 = performance.now()
      while (performance.now() - t0 < 600) {
        await new Promise((r) => requestAnimationFrame(r))
        const now = top()
        if (now === undefined) return Infinity
        max = Math.max(max, Math.abs(now - from))
      }
      return max
    })
    expect(moved).toBeLessThanOrEqual(1)
    landed++
  }
  expect(landed).toBe(3)
  expect((await reads(page)).pop()).toMatch(/before=.*last=500|last=500.*before=/)
})

test('a thread the pointer rested on opens drawn, with nothing read on the way', async ({ page }) => {
  await record(page)
  await page.goto('/computer/work?fake=long')
  const row = page.locator(`[data-nav="thread:${SID}"]`).first()
  await row.hover()
  await expect.poll(() => reads(page)).toContain('?last=200')
  await page.waitForTimeout(300)
  const before = await reads(page)
  await frames(page)
  await row.click()
  await page.waitForSelector(ROW)
  await page.waitForTimeout(500)
  // From the first frame the pane is there, it shows the thread's end.
  const pane = (await frames(page)).filter((f) => f.height > 0)
  for (const f of pane) {
    expect(f.rows).toBeGreaterThan(0)
    expect(f.reading).toBe(false)
    expect(f.bottom).toBeLessThanOrEqual(1)
  }
  expect((await reads(page)).filter((q) => q.includes('last='))).toEqual(before)
})
