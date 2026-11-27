import { notifyError } from '@/lib/errors'
import { useTransientFlag } from '@/lib/use-transient-flag'

/** Copy to the clipboard; "Copied" only once the write succeeds (the
 * clipboard can be blocked by permissions or an insecure context). */
export function useCopy(text: string, onCopy?: () => void) {
  const [copied, markCopied] = useTransientFlag(1500)
  const copy = () => {
    void navigator.clipboard.writeText(text).then(
      () => {
        markCopied()
        onCopy?.()
      },
      (e: unknown) => notifyError("Couldn't copy to clipboard.", e),
    )
  }
  return [copied, copy] as const
}
