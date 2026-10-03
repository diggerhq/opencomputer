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

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((byte, index) => bytes[offset + index] === byte)
}

/** The image type the bytes are, whatever the file claims to be. */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png'
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp'
  }
  return undefined
}

/**
 * A chat file part carrying the image inline as a data URL, or undefined
 * when the bytes are not a supported image.
 */
export async function imagePart(file: File): Promise<FileUIPart | undefined> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mediaType = sniffImageType(bytes)
  if (!mediaType) return undefined
  return {
    type: 'file',
    mediaType,
    ...(file.name ? { filename: file.name } : {}),
    url: `data:${mediaType};base64,${base64(bytes)}`,
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
