import { describe, expect, it } from 'vitest'
import { z } from 'zod'

/**
 * The declared-channel schema is what decides which wizard a customer sees.
 * Slack has an app to install; Twilio has credentials to paste and a number to
 * point here. Getting the discriminator wrong shows the wrong form entirely.
 */
const declaredChannel = z.object({
  id: z.string(),
  type: z.enum(['slack', 'twilio', 'email']),
  displayName: z.string().optional(),
  destinations: z.record(
    z.string(),
    z.object({
      type: z.enum(['conversation', 'reply']),
      visibility: z.enum(['public', 'private']).optional(),
    }),
  ),
})

describe('declared channels drive the connect flow', () => {
  it('accepts a Twilio channel, which has no scopes and no visibility', () => {
    const parsed = declaredChannel.parse({
      id: 'shop-sms',
      type: 'twilio',
      destinations: { reply: { type: 'reply' } },
    })
    expect(parsed.type).toBe('twilio')
    expect(parsed.destinations.reply?.visibility).toBeUndefined()
  })

  it('still accepts a Slack channel with a public conversation', () => {
    const parsed = declaredChannel.parse({
      id: 'team-slack',
      type: 'slack',
      displayName: 'Engineering',
      destinations: {
        'pull-request-reviews': { type: 'conversation', visibility: 'public' },
      },
    })
    expect(parsed.destinations['pull-request-reviews']?.visibility).toBe('public')
  })

  it('refuses a provider the dashboard has no flow for', () => {
    expect(() =>
      declaredChannel.parse({ id: 'x', type: 'carrier-pigeon', destinations: {} }),
    ).toThrow()
  })
})
