import { describe, expect, it } from 'vitest'
import { sandboxStatusLabel } from '@/lib/sandbox-status'

describe('sandboxStatusLabel', () => {
  it('presents a stopped (destroyed) sandbox as Deleted', () => {
    expect(sandboxStatusLabel('stopped')).toBe('Deleted')
  })

  it.each(['running', 'hibernated', 'error', 'pending'])(
    'leaves %s to the default badge label',
    (status) => {
      expect(sandboxStatusLabel(status)).toBeUndefined()
    },
  )
})
