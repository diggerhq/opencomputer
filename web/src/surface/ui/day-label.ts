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
