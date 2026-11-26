import { ApiError } from '@/api/client'

export function quoteDatabaseIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

export function isUnprovisionedDatabaseError(error: unknown) {
  return error instanceof ApiError && error.type === 'database_not_provisioned'
}
