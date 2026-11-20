import { describe, expect, it } from 'vitest'
import { formatSlackDate, fromSlack } from './slack-text'

const opts = {
  now: new Date(Date.UTC(2026, 10, 20, 12)),
  timeZone: 'UTC',
  locale: 'en-US',
}

describe('fromSlack', () => {
  it('fills in a date token instead of showing it raw', () => {
    expect(
      fromSlack(
        'active since <!date^1794617640^{date_short_pretty} at {time}|Nov 9 00:54 UTC> (Nov 8 on US time)',
        opts,
      ),
    ).toBe('active since Nov 14, 2026 at 12:54 AM (Nov 8 on US time)')
  })

  it('says today or yesterday for pretty dates nearby', () => {
    const today = Date.UTC(2026, 10, 20, 9) / 1000
    expect(formatSlackDate(today, '{date_pretty}', opts)).toBe('today')
    expect(formatSlackDate(today - 86_400, '{date_short_pretty}', opts)).toBe(
      'yesterday',
    )
  })

  it('links a date that carries a link', () => {
    expect(
      fromSlack('<!date^1794617640^{date_num}^https://x.dev|fallback>', opts),
    ).toBe('[2026-11-14](https://x.dev)')
  })

  it('turns links, mentions and channels into Markdown', () => {
    expect(
      fromSlack(
        'see <https://a.dev/x|the doc>, ask @Sam (<@U123>) or <@U9|kim> in <#C1|eng>, <!here>',
      ),
    ).toBe('see [the doc](https://a.dev/x), ask @Sam or @kim in #eng, @here')
  })

  it('leaves ordinary text and Markdown alone', () => {
    const md = '**bold** `<x>` [a](https://b) a < b > c'
    expect(fromSlack(md)).toBe(md)
  })
})
