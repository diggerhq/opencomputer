// When something happened, as the list shows it: today, a weekday, or a date.
export const when = (
  iso: string | number | null | undefined,
  now = Date.now(),
): string => {
  if (!iso) return ''
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime()
  const d = new Date(t)
  const days = Math.floor(
    (new Date(now).setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) /
      86400000,
  )
  if (days <= 0) return 'today'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

// How long ago, as a row shows it on hover: "now", "5m", "3h", "2d", then `when`.
export const ago = (
  iso: string | number | null | undefined,
  now = Date.now(),
): string => {
  if (!iso) return ''
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime()
  const m = Math.floor((now - t) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h`
  if (m < 7 * 1440) return `${Math.floor(m / 1440)}d`
  return when(t, now)
}
