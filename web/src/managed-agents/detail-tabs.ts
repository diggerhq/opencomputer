export type DetailTab =
  | 'playground'
  | 'deployments'
  | 'sessions'
  | 'schedules'
  | 'webhooks'
  | 'memory'
  | 'database'
  | 'secrets'
  | 'connections'
  | 'github'
  | 'byok'
  | 'settings'

export const PROJECT_DETAIL_TABS = new Set<DetailTab>([
  'playground',
  'deployments',
  'sessions',
  'schedules',
  'webhooks',
  'memory',
  'database',
  'secrets',
  'connections',
  'github',
  'byok',
  'settings',
])
