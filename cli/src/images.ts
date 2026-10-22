import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

/** An image sent with a turn: base64 bytes without a `data:` prefix. */
export interface TurnImage {
  type: "image";
  mediaType: string;
  data: string;
  name: string;
}

export const IMAGE_LIMIT = 4;
export const IMAGE_BYTES = 5 * 1024 * 1024;

function startsWith(bytes: Uint8Array, signature: number[], offset = 0) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** The image type the bytes are, whatever the file is named. */
export function imageMediaType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return undefined;
}

/** Reads each `--image` path into a turn attachment, refusing what the agent cannot take. */
export async function readTurnImages(paths: string[]): Promise<TurnImage[]> {
  if (paths.length > IMAGE_LIMIT) {
    throw new Error(`At most ${IMAGE_LIMIT} --image files can be sent with a prompt.`);
  }
  return Promise.all(
    paths.map(async (path) => {
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) throw new Error(`--image ${path} is not a file.`);
      if (info.size > IMAGE_BYTES) {
        throw new Error(`--image ${path} is larger than 5 MB.`);
      }
      const bytes = await readFile(path);
      const mediaType = imageMediaType(bytes);
      if (!mediaType) {
        throw new Error(`--image ${path} is not a PNG, JPEG, GIF or WebP image.`);
      }
      return {
        type: "image" as const,
        mediaType,
        data: bytes.toString("base64"),
        name: basename(path),
      };
    }),
  );
}
