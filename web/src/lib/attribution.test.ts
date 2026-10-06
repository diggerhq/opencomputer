import { describe, expect, it } from 'vitest'
import {
  computeTouch,
  cookieString,
  mergeCookie,
  parseCookie,
  recordTouch,
  type Touch,
} from '@/lib/attribution'

const NOW = new Date(1_790_000_000_500)

function touch(overrides: Partial<Touch> = {}): Touch {
  return {
    t: 1_790_000_000,
    src: null,
    med: null,
    cmp: null,
    term: null,
    cnt: null,
    ref: null,
    lp: 'app.opencomputer.dev/',
    gclid: null,
    fbclid: null,
    ...overrides,
  }
}

function decode(raw: string): unknown {
  return JSON.parse(decodeURIComponent(raw))
}

describe('computeTouch', () => {
  it('maps utm_* to lowercased, trimmed fields and strips queries', () => {
    expect(
      computeTouch(
        'https://app.opencomputer.dev/signup?utm_source=%20Twitter%20&utm_medium=Social&utm_campaign=Launch&utm_term=AI&utm_content=Hero',
        'https://t.co/abc?x=1',
        NOW,
      ),
    ).toEqual({
      t: 1_790_000_000,
      src: 'twitter',
      med: 'social',
      cmp: 'launch',
      term: 'ai',
      cnt: 'hero',
      ref: 't.co/abc',
      lp: 'app.opencomputer.dev/signup',
      gclid: null,
      fbclid: null,
    })
  })

  it('emits fields in the C1 order', () => {
    const result = computeTouch(
      'https://app.opencomputer.dev/?utm_source=x',
      '',
      NOW,
    )
    expect(Object.keys(result!)).toEqual([
      't',
      'src',
      'med',
      'cmp',
      'term',
      'cnt',
      'ref',
      'lp',
      'gclid',
      'fbclid',
    ])
  })

  it('records nothing on internal navigation', () => {
    expect(
      computeTouch(
        'https://app.opencomputer.dev/projects',
        'https://opencomputer.dev/pricing',
        NOW,
      ),
    ).toBeNull()
    expect(
      computeTouch('https://app.opencomputer.dev/projects', '', NOW),
    ).toBeNull()
  })

  it('records an external referrer without utm, leaving src null', () => {
    expect(
      computeTouch(
        'https://app.opencomputer.dev/',
        'https://www.google.com/',
        NOW,
      ),
    ).toEqual(touch({ ref: 'www.google.com/' }))
  })

  it('records gclid and fbclid alone, keeping their case', () => {
    expect(
      computeTouch('https://app.opencomputer.dev/?gclid=AbC123', '', NOW),
    ).toEqual(touch({ gclid: 'AbC123' }))
    expect(
      computeTouch('https://app.opencomputer.dev/?fbclid=XyZ', '', NOW),
    ).toEqual(touch({ fbclid: 'XyZ' }))
  })

  it('treats any utm_* parameter as a touch', () => {
    expect(
      computeTouch('https://app.opencomputer.dev/?utm_id=42', '', NOW),
    ).toEqual(touch())
  })

  it('keeps an internal referrer on a tagged touch', () => {
    expect(
      computeTouch(
        'https://app.opencomputer.dev/?utm_source=newsletter',
        'https://opencomputer.dev/blog/post?ref=1',
        NOW,
      ),
    ).toEqual(touch({ src: 'newsletter', ref: 'opencomputer.dev/blog/post' }))
  })

  it('caps utm fields at 100 and urls at 200 characters', () => {
    const long = 'a'.repeat(300)
    const result = computeTouch(
      `https://app.opencomputer.dev/${long}?utm_source=${long}`,
      `https://example.com/${long}`,
      NOW,
    )!
    expect(result.src).toHaveLength(100)
    expect(result.ref).toHaveLength(200)
    expect(result.lp).toHaveLength(200)
  })

  it('treats empty parameters as absent', () => {
    expect(
      computeTouch('https://app.opencomputer.dev/?utm_source=%20', '', NOW),
    ).toBeNull()
  })

  it('ignores an unparseable referrer', () => {
    expect(
      computeTouch('https://app.opencomputer.dev/', 'not a url', NOW),
    ).toBeNull()
  })
})

describe('mergeCookie', () => {
  it('writes ft and lt from the first touch', () => {
    const first = touch({ src: 'twitter' })
    expect(decode(mergeCookie(null, first))).toEqual({
      v: 1,
      ft: first,
      lt: first,
    })
  })

  it('keeps ft and overwrites lt on later touches', () => {
    const first = touch({ src: 'twitter' })
    const second = touch({ t: 1_790_000_100, src: 'google' })
    const third = touch({ t: 1_790_000_200, src: 'reddit' })
    const raw = mergeCookie(
      mergeCookie(mergeCookie(null, first), second),
      third,
    )
    expect(decode(raw)).toEqual({ v: 1, ft: first, lt: third })
  })

  it('serializes as URL-encoded JSON in C1 key order', () => {
    const raw = mergeCookie(null, touch())
    expect(decodeURIComponent(raw)).toBe(
      '{"v":1,"ft":{"t":1790000000,"src":null,"med":null,"cmp":null,"term":null,"cnt":null,"ref":null,"lp":"app.opencomputer.dev/","gclid":null,"fbclid":null},"lt":{"t":1790000000,"src":null,"med":null,"cmp":null,"term":null,"cnt":null,"ref":null,"lp":"app.opencomputer.dev/","gclid":null,"fbclid":null}}',
    )
    expect(raw).not.toMatch(/[;,\s"]/)
  })

  it.each([
    ['garbage', 'not-json'],
    ['bad encoding', '%E0%A4%A'],
    ['wrong version', encodeURIComponent('{"v":2,"ft":{},"lt":{}}')],
    ['missing ft', encodeURIComponent('{"v":1,"lt":{"t":1}}')],
    [
      'bad field type',
      encodeURIComponent(
        JSON.stringify({
          v: 1,
          ft: touch({ src: 5 as unknown as string }),
          lt: touch(),
        }),
      ),
    ],
    ['empty', ''],
  ])('replaces a malformed cookie (%s) as if absent', (_, existing) => {
    const next = touch({ src: 'google' })
    expect(decode(mergeCookie(existing, next))).toEqual({
      v: 1,
      ft: next,
      lt: next,
    })
  })

  it('drops unknown fields from an existing ft', () => {
    const existing = encodeURIComponent(
      JSON.stringify({ v: 1, ft: { ...touch(), extra: 'x' }, lt: touch() }),
    )
    expect(parseCookie(mergeCookie(existing, touch()))?.ft).toEqual(touch())
  })
})

describe('cookieString', () => {
  it('scopes to .opencomputer.dev on the production hosts', () => {
    expect(
      cookieString('v', {
        hostname: 'app.opencomputer.dev',
        protocol: 'https:',
      }),
    ).toBe(
      'oc_attr=v; Domain=.opencomputer.dev; Path=/; Max-Age=7776000; SameSite=Lax; Secure',
    )
  })

  it('is host-only elsewhere and omits Secure on http', () => {
    expect(
      cookieString('v', { hostname: 'localhost', protocol: 'http:' }),
    ).toBe('oc_attr=v; Path=/; Max-Age=7776000; SameSite=Lax')
  })
})

describe('recordTouch', () => {
  const location = {
    href: 'https://app.opencomputer.dev/?utm_source=google',
    hostname: 'app.opencomputer.dev',
    protocol: 'https:',
  }

  it('writes the merged cookie, keeping an existing first touch', () => {
    const first = touch({ src: 'twitter' })
    const doc = { cookie: `other=1; oc_attr=${mergeCookie(null, first)}` }
    recordTouch(location, '', NOW, doc)
    const [pair, ...attrs] = doc.cookie.split('; ')
    expect(attrs).toEqual([
      'Domain=.opencomputer.dev',
      'Path=/',
      'Max-Age=7776000',
      'SameSite=Lax',
      'Secure',
    ])
    expect(pair.startsWith('oc_attr=')).toBe(true)
    expect(decode(pair.slice('oc_attr='.length))).toEqual({
      v: 1,
      ft: first,
      lt: touch({ src: 'google', lp: 'app.opencomputer.dev/' }),
    })
  })

  it('does not write when there is no touch', () => {
    const doc = { cookie: 'other=1' }
    recordTouch(
      { ...location, href: 'https://app.opencomputer.dev/projects' },
      'https://opencomputer.dev/',
      NOW,
      doc,
    )
    expect(doc.cookie).toBe('other=1')
  })
})
