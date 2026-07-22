import { describe, expect, it } from 'vitest'
import {
  formatDuration,
  formatUsageCost,
  formatUsageDuration,
  formatUsageTokens,
  usageDisclosure,
} from './usage'

describe('canonical usage presentation', () => {
  it('renders complete session usage as exact values', () => {
    const usage = {
      active_seconds: 65,
      reported_turns: 1,
      unreported_turns: 0,
      complete: true,
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      tokens: 15,
      total_cost_usd: 0.0042,
      attribution: 'exact' as const,
    }

    expect(formatUsageTokens(usage)).toBe('15')
    expect(formatUsageCost(usage)).toBe('$0.0042')
    expect(formatUsageDuration(usage)).toBe('1m 05s')
    expect(usageDisclosure(usage)).toBeNull()
  })

  it('marks incomplete totals and best-effort attribution', () => {
    const usage = {
      active_seconds: 4,
      reported_turns: 2,
      unreported_turns: 1,
      complete: false,
      tokens: 1234,
      total_cost_usd: 0.12,
      attribution: 'best_effort' as const,
    }

    expect(formatUsageTokens(usage)).toBe('≥1,234')
    expect(formatUsageCost(usage)).toBe('≥$0.120')
    expect(usageDisclosure(usage)).toBe(
      'Lower bound · 1 turn did not report usage · Best-effort session attribution',
    )
  })

  it('marks a partially reported turn as a lower bound', () => {
    const usage = {
      reported: true as const,
      complete: false as const,
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      tokens: 120,
    }

    expect(formatUsageTokens(usage)).toBe('≥120')
    expect(usageDisclosure(usage)).toBe('Lower-bound usage')
  })

  it('keeps missing and historical usage unknown', () => {
    expect(formatUsageTokens({})).toBe('Unknown')
    expect(formatUsageCost({ reported: false })).toBe('Unknown')
    expect(formatUsageDuration(null)).toBe('Unknown')
  })

  it('formats long active durations compactly', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(59)).toBe('59s')
    expect(formatDuration(3661)).toBe('1h 01m')
  })
})
