import { toast } from 'sonner'

/**
 * Show a clear, human error toast and send the raw error to the console for
 * debugging. Keeps raw messages, HTTP codes, and stack detail out of the UI —
 * the toast says what failed in plain language; `console.error` keeps the
 * detail for developers.
 */
export function notifyError(message: string, error?: unknown): void {
  if (error !== undefined) console.error(message, error)
  toast.error(message)
}
