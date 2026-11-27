import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The type sizes index.css adds to Tailwind's scale, so `text-reading` is
// merged as a size (it replaces `text-sm`), not taken for a color.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ['meta', 'reading', 'mono'] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
