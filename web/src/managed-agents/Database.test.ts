import { describe, expect, it } from 'vitest'
import { quoteDatabaseIdentifier } from './Database'

describe('quoteDatabaseIdentifier', () => {
  it('quotes table names', () => {
    expect(quoteDatabaseIdentifier('monitors')).toBe('"monitors"')
  })

  it('escapes embedded quotes', () => {
    expect(quoteDatabaseIdentifier('odd"name')).toBe('"odd""name"')
  })
})
