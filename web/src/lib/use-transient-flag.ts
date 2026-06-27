import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A boolean that flips `true` on `trigger()` and auto-resets to `false` after
 * `ms`. Centralizes the repeated "set a flag, clear it on a timer" pattern
 * (copied / saved confirmations) with proper cleanup — the timer is cleared on
 * unmount, so it never calls setState after the component is gone.
 */
export function useTransientFlag(ms = 2000): [boolean, () => void] {
  const [on, setOn] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const trigger = useCallback(() => {
    setOn(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOn(false), ms)
  }, [ms])

  return [on, trigger]
}
