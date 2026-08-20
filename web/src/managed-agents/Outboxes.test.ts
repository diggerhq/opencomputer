import { describe, expect, it } from 'vitest'
import type { ManagedAgentOutbox } from './api'
import { flattenOutboxDeliveries } from './Outboxes'

function route(
  id: string,
  items: ManagedAgentOutbox['items'],
): ManagedAgentOutbox {
  return {
    id,
    channelId: 'team-slack',
    channelName: 'Team Slack',
    destination: 'pull-request-reviews',
    readiness: 'ready',
    items,
  }
}

function item(
  id: string,
  createdAt: string,
): ManagedAgentOutbox['items'][number] {
  return {
    id,
    outboxId: 'reviews',
    eventType: 'pull_request.created',
    contentPreview: { title: id },
    status: 'delivered',
    attemptCount: 1,
    createdAt,
    updatedAt: createdAt,
  }
}

describe('flattenOutboxDeliveries', () => {
  it('orders publications across routes by newest first', () => {
    const deliveries = flattenOutboxDeliveries([
      route('reviews', [item('older', '2026-08-15T10:00:00.000Z')]),
      route('personal', [item('newer', '2026-08-15T11:00:00.000Z')]),
    ])

    expect(deliveries.map(({ item: delivery }) => delivery.id)).toEqual([
      'newer',
      'older',
    ])
  })
})
