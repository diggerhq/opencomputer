export function json(
  value: unknown,
  init: ResponseInit | number = 200,
): Response {
  const responseInit = typeof init === "number" ? { status: init } : init;
  const headers = new Headers(responseInit.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), {
    ...responseInit,
    headers,
  });
}

export function problem(
  status: number,
  code: string,
  message: string,
  /** Identity the caller needs to retry or find what the failure concerns, beside the code and message. */
  details: Record<string, unknown> = {},
): Response {
  return json({ error: { code, message, ...details } }, status);
}

export async function readJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function readBoundedJson(
  request: Request,
  maximumBytes: number,
): Promise<Record<string, unknown> | null> {
  const text = await readBoundedText(request, maximumBytes);
  if (text === null) return null;
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export async function readBoundedText(
  request: Request,
  maximumBytes: number,
): Promise<string | null> {
  const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maximumBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("request body too large");
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
