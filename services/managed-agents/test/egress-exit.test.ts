import { describe, expect, it } from "vitest";

import registry from "./fixtures/egress-registry.json" with { type: "json" };
import {
  EXIT_CONTROLLER,
  EXIT_SELECTOR,
  MODAL_DNS,
  exitClientConfig,
  exitCredential,
  utcDay,
} from "../src/egress-exit.js";

const KEY = "00".repeat(16) + "ff".repeat(16);

describe("egress exits (work 073)", () => {
  it("derives the same credential as the exit (egress.py)", async () => {
    // Vectors from `egress.credential` in deploy/egress/server/egress.py.
    expect(await exitCredential(KEY, "dep_abc", "2026-10-19")).toBe("bafb45ae-7573-4839-900d-a177d0c57d72");
    expect(await exitCredential(KEY, "smoke-open", "2026-01-01")).toBe("92f6f127-8455-4920-8659-0b9a4c12aa11");
    expect(await exitCredential(KEY.toUpperCase(), "dep_abc", "2026-10-19")).toBe(
      "bafb45ae-7573-4839-900d-a177d0c57d72",
    );
  });

  it("refuses short keys and malformed days", async () => {
    await expect(exitCredential("00".repeat(31), "dep_abc", "2026-10-19")).rejects.toThrow(/32\+ bytes/);
    await expect(exitCredential(KEY, "dep_abc", "2026-10-19T00")).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("uses the UTC day", () => {
    expect(utcDay(new Date("2026-10-19T23:30:00-05:00"))).toBe("2026-10-20");
  });

  it("puts a region's exits behind one selector, with DNS outside the tunnel", () => {
    const au = registry.exits.filter((exit) => exit.region === "au");
    const config = exitClientConfig(au, "uuid") as {
      inbounds: { route_exclude_address: string[] }[];
      outbounds: { type: string; tag: string; outbounds?: string[]; default?: string; server?: string }[];
      route: { final: string };
      experimental: { clash_api: { external_controller: string } };
    };
    const [selector, ...vless] = config.outbounds;
    expect(selector).toMatchObject({ type: "selector", tag: EXIT_SELECTOR, default: "oc-exit-au-1" });
    expect(selector!.outbounds).toEqual(au.map((exit) => exit.app));
    expect(vless.map((outbound) => outbound.server)).toEqual(au.map((exit) => exit.server));
    expect(config.route.final).toBe(EXIT_SELECTOR);
    expect(config.inbounds[0]!.route_exclude_address).toEqual([`${MODAL_DNS}/32`]);
    expect(config.experimental.clash_api.external_controller).toBe(EXIT_CONTROLLER);
    expect(() => exitClientConfig([], "uuid")).toThrow(/no exits/);
  });
});
