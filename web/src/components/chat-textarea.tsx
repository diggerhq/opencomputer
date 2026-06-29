import { useLayoutEffect, useRef, type ComponentProps } from 'react'
import { Textarea } from '@/components/form'
import { cn } from '@/lib/utils'

type ChatTextareaProps = ComponentProps<typeof Textarea> & {
  /** Fired when the user presses Enter (or ⌘/Ctrl+Enter). Shift+Enter inserts a
   *  newline. The caller decides whether to actually send (e.g. guard on
   *  non-empty / not in-flight); a disabled textarea never fires this. */
  onSend?: () => void
}

/** Chat-style textarea: auto-grows with its content (up to ~6 rows, then
 *  scrolls) and sends on Enter, newline on Shift+Enter. One home for the
 *  keyboard + sizing semantics so every "send a message" box — steer, start
 *  session — behaves the same. (Not for multi-field forms, where Enter must not
 *  submit; use the plain Textarea there.) */
export function ChatTextarea({
  onSend,
  value,
  onKeyDown,
  className,
  ...props
}: ChatTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null)
  // Grow to fit content (cap, then scroll); shrink back when cleared after send.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [value])
  return (
    <Textarea
      ref={ref}
      value={value}
      rows={1}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        // Enter (or ⌘/Ctrl+Enter) sends; Shift+Enter is a newline. Skip Enter
        // mid-IME-composition so CJK/accent input isn't cut off.
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          onSend?.()
        }
      }}
      className={cn('max-h-40 overflow-y-auto', className)}
      {...props}
    />
  )
}
