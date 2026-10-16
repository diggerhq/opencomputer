import { describe, expect, it } from 'vitest'

import { imageAttachments, imagePart, imageRefusal } from './images'

const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
)

describe('managed agent images', () => {
  it('types an image by its bytes rather than its name', async () => {
    const part = await imagePart(
      new File([PNG], 'photo.jpg', { type: 'image/jpeg' }),
    )
    expect(part?.mediaType).toBe('image/png')
    expect(imageAttachments(part ? [part] : [])).toEqual([
      {
        type: 'image',
        mediaType: 'image/png',
        data: btoa(String.fromCharCode(...PNG)),
        name: 'photo.jpg',
      },
    ])
  })

  it('refuses a renamed file that is not an image', async () => {
    const renamed = new File(['just text'], 'notes.png', { type: 'image/png' })
    expect(imageRefusal(renamed)).toBeUndefined()
    await expect(imagePart(renamed)).resolves.toBeUndefined()
  })

  it('refuses unsupported types and oversized images up front', () => {
    expect(
      imageRefusal({ name: 'logo.svg', type: 'image/svg+xml', size: 10 }),
    ).toMatch(/not a PNG, JPEG, GIF or WebP/)
    expect(
      imageRefusal({ name: 'big.png', type: 'image/png', size: 6 << 20 }),
    ).toMatch(/larger than 5 MB/)
  })
})
