import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import {
  isUnprovisionedDatabaseError,
  quoteDatabaseIdentifier,
} from './Database'

describe('quoteDatabaseIdentifier', () => {
  it('quotes table names', () => {
    expect(quoteDatabaseIdentifier('monitors')).toBe('"monitors"')
  })

  it('escapes embedded quotes', () => {
    expect(quoteDatabaseIdentifier('odd"name')).toBe('"odd""name"')
  })
})

describe('isUnprovisionedDatabaseError', () => {
  it('recognizes the typed legacy deployment state', () => {
    expect(
      isUnprovisionedDatabaseError(
        new ApiError('Conflict', 409, 'database_not_provisioned'),
      ),
    ).toBe(true)
  })

  it('leaves real query failures visible as errors', () => {
    expect(
      isUnprovisionedDatabaseError(
        new ApiError('Query failed', 400, 'database_query_failed'),
      ),
    ).toBe(false)
  })
})
