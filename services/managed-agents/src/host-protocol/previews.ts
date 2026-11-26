// Preview URLs: the tunnel config and the `preview` / `unpreview` requests and answers.

/**
 * Work 074, preview URLs. The host runs `cloudflared tunnel run` with
 * `tunnelToken` in TUNNEL_TOKEN, and its preview proxy on 127.0.0.1:7070
 * forwards only `ports`, only requests signed with `key` (blue
 * src/previews/auth.ts: `X-Preview-Auth: <expiry ms>.<base64url
 * HMAC-SHA256(key, "<port>|<expiry ms>")>`).
 */
export interface CalvinPreviewConfig {
  tunnelToken: string;
  /** base64url, 32 bytes. */
  key: string;
  ports: number[];
}

export interface CalvinPreviewRequest {
  port: number;
  /** A chosen name (one DNS label); without one the gateway generates one, or returns the port's existing name. */
  name?: string;
}

/** `unpreview` answers with `{ url: "", name, port: 0 }`. */
export interface CalvinPreviewResult {
  url: string;
  name: string;
  port: number;
}
