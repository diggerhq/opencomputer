import { createContext } from 'react'

// What the attachment chips (Attachments.tsx) share with the rest of the surface.

// An image this big or smaller is drawn as a thumbnail; a larger one is a chip to download.
export const THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024

export const isImage = (a: { mimetype: string; bytes: number }) => a.mimetype.startsWith('image/') && a.bytes <= THUMBNAIL_MAX_BYTES

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  const mb = n / 1024 / 1024
  return `${mb < 10 ? Math.round(mb * 10) / 10 : Math.round(mb)} MB`
}

// The session the conversation on screen belongs to: where a chip reads its bytes from.
export const SessionContext = createContext<string>('')
