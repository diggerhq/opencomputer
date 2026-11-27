// The object store of attachments (work 126, section 5): the bytes, keyed `<org>/<session>/<id>`,
// beside Org's rows. The R2 implementation is here; Org's Durable Object owes `Attachments.delete`
// and `Attachments.removeAll` to it, and the API handler streams a request's body into `put` and an
// object out of `get` so no actor ever holds an attachment's bytes.
//
// TODO(work 126): a directory implementation for the one-VM / workerd self-host, once Blobs has one
// to follow (today `SESSION_LOG_BLOBS` is R2-only as well, session-log/durable-object.ts `r2Blobs`).

/** A byte range of an object, as `get` was asked for it: `offset` from the start, `length` bytes. */
export interface AttachmentRange {
  offset: number;
  length: number;
}

export interface StoredAttachment {
  body: ReadableStream;
  /** The object's whole size. */
  bytes: number;
  etag: string;
  /** Present when a range was asked for and served. */
  range?: AttachmentRange;
}

export interface Attachments {
  /**
   * Store `body`, declared as `bytes` long. A body of another length fails and nothing is stored:
   * the row's `bytes` is the client's `content-length`, and the quota was taken for it.
   */
  put(key: string, body: ReadableStream, meta: { bytes: number; contentType: string }): Promise<{ etag: string }>;
  get(key: string, range?: AttachmentRange): Promise<StoredAttachment | null>;
  delete(key: string): Promise<void>;
  /** Delete every object under the prefix. */
  removeAll(prefix: string): Promise<void>;
}

/** A body-of-another-length failure: the handler answers it `content_mismatch`. */
export class LengthMismatch extends TypeError {
  constructor(expected: number, seen: number, more: boolean) {
    super(`The body is ${more ? "longer" : `${seen} bytes, not ${expected}`}; expected ${expected} bytes.`);
    this.name = "LengthMismatch";
  }
}

/**
 * A stream that is exactly `bytes` long, failing one that is shorter or longer. The Workers runtime's
 * `FixedLengthStream` (which R2 also needs to know a streamed body's length); a counting transform
 * elsewhere (node tests, a directory store).
 */
export function fixedLength(bytes: number): { readable: ReadableStream; writable: WritableStream } {
  const Fixed = (globalThis as { FixedLengthStream?: new (bytes: number) => { readable: ReadableStream; writable: WritableStream } }).FixedLengthStream;
  if (Fixed) return new Fixed(bytes);
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > bytes) throw new LengthMismatch(bytes, seen, true);
      controller.enqueue(chunk);
    },
    flush() {
      if (seen !== bytes) throw new LengthMismatch(bytes, seen, false);
    },
  });
}

export function r2Attachments(bucket: R2Bucket): Attachments {
  return {
    put: async (key, body, meta) => {
      // R2 needs a known length for a streamed body; the fixed-length stream also fails a body that is shorter or longer.
      const fixed = fixedLength(meta.bytes);
      let lengthError: unknown;
      const piping = body.pipeTo(fixed.writable).catch((error: unknown) => {
        lengthError = error;
        throw error;
      });
      try {
        const object = await bucket.put(key, fixed.readable, { httpMetadata: { contentType: meta.contentType } });
        await piping;
        return { etag: object.httpEtag };
      } catch (error) {
        // The store failed before it drained the body: let the pipe go, or it waits for a reader forever.
        await fixed.readable.cancel(error).catch(() => undefined);
        await piping.catch(() => undefined);
        // The pipe's own failure (a body of another length) is the one to tell, not the store's reading of it.
        throw lengthError ?? error;
      }
    },
    get: async (key, range) => {
      const object = await bucket.get(key, range ? { range } : undefined);
      if (!object) return null;
      return { body: object.body, bytes: object.size, etag: object.httpEtag, ...(range ? { range } : {}) };
    },
    delete: (key) => bucket.delete(key),
    removeAll: async (prefix) => {
      for (let cursor: string | undefined; ; ) {
        const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
        if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
        if (!page.truncated) return;
        cursor = page.cursor;
      }
    },
  };
}

/** The key of one attachment's object. */
export const attachmentKey = (org: string, sessionId: string, id: string): string => `${org}/${sessionId}/${id}`;
/** The prefix of a session's objects. */
export const attachmentPrefix = (org: string, sessionId: string): string => `${org}/${sessionId}/`;
