// Calls back when the network may be back: the browser is online again, or the
// tab is shown.
export const pageWake = (cb: () => void) => {
  if (typeof window === 'undefined') return () => {}
  const shown = () => {
    if (document.visibilityState === 'visible') cb()
  }
  window.addEventListener('online', cb)
  document.addEventListener('visibilitychange', shown)
  return () => {
    window.removeEventListener('online', cb)
    document.removeEventListener('visibilitychange', shown)
  }
}
