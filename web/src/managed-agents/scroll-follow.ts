export const SCROLL_FOLLOW_THRESHOLD = 96

type ScrollMetrics = Pick<
  HTMLElement,
  'scrollHeight' | 'scrollTop' | 'clientHeight'
>

export function isNearScrollEnd(
  metrics: ScrollMetrics,
  threshold = SCROLL_FOLLOW_THRESHOLD,
) {
  return (
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
  )
}
