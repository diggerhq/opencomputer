import { describe, expect, it } from "vitest";
import { layerOcEnv } from "./cf-env.js";

describe("Cloudflare env layering", () => {
  it("prefers ambient values and reads request secrets without enumerating the fallback proxy", () => {
    const fallback = new Proxy<Record<string, unknown>>(
      {},
      {
        get(_target, property) {
          if (property === "OC_REPO_API") return "https://fallback.invalid";
          if (property === "OC_SESSION_TOKEN") return "request-token";
          return undefined;
        },
        ownKeys() {
          throw new Error("runtime env must not be enumerated");
        },
      },
    );
    const ambient = {
      OC_REPO_API: "https://repositories.test",
      OC_SESSION_TOKEN: undefined,
    };

    const resolved = layerOcEnv(ambient, fallback);

    expect(resolved.OC_REPO_API).toBe("https://repositories.test");
    expect(resolved.OC_SESSION_TOKEN).toBe("request-token");
    expect(layerOcEnv(ambient, undefined)).toBe(ambient);
  });
});
