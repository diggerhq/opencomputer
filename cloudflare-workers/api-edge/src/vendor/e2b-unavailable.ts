export const ALL_TRAFFIC = Symbol("e2b-unavailable");

export class NotFoundError extends Error {}

export class Sandbox {
  static create(): never {
    throw new Error("E2B sandbox support is not configured for this Cloudflare Worker");
  }

  static kill(): never {
    throw new Error("E2B sandbox support is not configured for this Cloudflare Worker");
  }

  static deleteSnapshot(): never {
    throw new Error("E2B sandbox support is not configured for this Cloudflare Worker");
  }
}
