import type { FileUIPart, UIMessage } from 'ai'
import type { ManagedAgentImage } from './api'

export const IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const
export const IMAGE_LIMIT = 4
export const IMAGE_BYTES = 5 * 1024 * 1024

/** Why a file cannot be sent to an agent as an image, if it cannot. */
export function imageRefusal(
  file: Pick<File, 'name' | 'type' | 'size'>,
): string | undefined {
  if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(file.type)) {
    return `${file.name || 'That file'} is not a PNG, JPEG, GIF or WebP image.`
  }
  if (file.size > IMAGE_BYTES) {
    return `${file.name || 'That image'} is larger than 5 MB.`
  }
  return undefined
}

function base64(bytes: Uint8Array) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/** A chat file part carrying the image inline as a data URL. */
export async function imagePart(file: File): Promise<FileUIPart> {
  const data = base64(new Uint8Array(await file.arrayBuffer()))
  return {
    type: 'file',
    mediaType: file.type,
    ...(file.name ? { filename: file.name } : {}),
    url: `data:${file.type};base64,${data}`,
  }
}

/** The inline images among a message's parts, as turn attachments. */
export function imageAttachments(
  parts: UIMessage['parts'] | FileUIPart[],
): ManagedAgentImage[] {
  return parts.flatMap((part) => {
    if (part.type !== 'file') return []
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(part.url)
    if (!match) return []
    return [
      {
        type: 'image' as const,
        mediaType: match[1],
        data: match[2],
        ...(part.filename ? { name: part.filename } : {}),
      },
    ]
  })
}
