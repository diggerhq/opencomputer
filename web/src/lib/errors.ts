import { toast } from 'sonner'

/**
 * Show a clear, human error toast and send the raw error to the console.
 * `message` is the plain-language title; the underlying error's message (e.g. an
 * API reason like "no resolvable credential") rides along as the toast
 * description so failures are actionable, while stacks/HTTP detail stay in the
 * console.
 */
export function notifyError(message: string, error?: unknown): void {
  if (error !== undefined) console.error(message, error)
  const detail = error instanceof Error ? error.message : undefined
  // Don't echo the title back as its own description.
  toast.error(
    message,
    detail && detail !== message ? { description: detail } : undefined,
  )
}

/** Show a brief success toast (e.g. confirming a deploy + which revision is now active). */
export function notifySuccess(message: string, description?: string): void {
  toast.success(message, description ? { description } : undefined)
}
