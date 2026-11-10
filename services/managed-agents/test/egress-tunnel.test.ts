import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

import { EGRESS_EXITS, EXIT_CONTROLLER, exitClientConfig } from "../src/egress-exit.js";
import {
  connectedSubnets,
  startEgressTunnel,
  type EgressTunnelDeps,
} from "../src/microvm/egress-tunnel.js";

// A Modal VM's table: default route, its /20, the gateway, two host routes via it.
const ROUTES = `Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0100500A\t0003\t0\t0\t100\t00000000\t0\t0\t0
eth0\t0000500A\t00000000\t0001\t0\t0\t100\t00F0FFFF\t0\t0\t0
eth0\t0100500A\t00000000\t0005\t0\t0\t100\tFFFFFFFF\t0\t0\t0
eth0\tFEA9FEA9\t0100500A\t0007\t0\t0\t100\tFFFFFFFF\t0\t0\t0
tun0\t000013AC\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0
`;

const AU = EGRESS_EXITS.filter((exit) => exit.region === "au");

function harness(healthy: (tag: string) => boolean) {
  const child = Object.assign(new EventEmitter(), { killed: false, kill: () => true }) as unknown as ChildProcess;
  const selected: string[] = [];
  let written = "";
  let exited: number | null | undefined;
  const deps: EgressTunnelDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.host).toBe(EXIT_CONTROLLER);
      const delay = /^\/proxies\/([^/]+)\/delay$/.exec(url.pathname);
      if (delay) {
        expect(url.searchParams.get("url")).toBe("https://edge.example.com/v1/egress-ips");
        return healthy(decodeURIComponent(delay[1]!))
          ? Response.json({ delay: 12 })
          : Response.json({ message: "timeout" }, { status: 504 });
      }
      if (url.pathname === "/proxies/exit" && init?.method === "PUT") {
        selected.push((JSON.parse(String(init.body)) as { name: string }).name);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${url.pathname}`);
    }) as typeof fetch,
    readRoutes: async () => ROUTES,
    writeConfig: async (_path, contents) => {
      written = contents;
    },
    spawnSingBox: () => child,
    log: () => undefined,
    onExit: (code) => {
      exited = code;
    },
  };
  const env = {
    BLUE_EGRESS_CLIENT: JSON.stringify(exitClientConfig(AU, "00000000-0000-4000-8000-000000000000")),
    BLUE_EGRESS_PROBE_URL: "https://edge.example.com/v1/egress-ips",
  };
  return { deps, env, child, selected, config: () => JSON.parse(written), exited: () => exited };
}

describe("sandbox egress tunnel (work 073)", () => {
  it("finds the sandbox's connected subnets, not the default route or the TUN", () => {
    expect(connectedSubnets(ROUTES)).toEqual(["10.80.0.0/20"]);
  });

  it("does nothing without a client config", async () => {
    expect(await startEgressTunnel({}, harness(() => true).deps)).toBeNull();
  });

  it("keeps the sandbox's subnets and Modal's resolver outside the tunnel", async () => {
    const h = harness(() => true);
    const tunnel = await startEgressTunnel(h.env, h.deps);
    tunnel!.stop();
    const tun = h.config().inbounds.find((inbound: { type: string }) => inbound.type === "tun");
    expect(tun.route_exclude_address).toEqual(["172.21.0.1/32", "10.80.0.0/20"]);
    expect(h.config().experimental.clash_api.external_controller).toBe(EXIT_CONTROLLER);
  });

  it("moves to the next healthy exit on every rotation", async () => {
    const h = harness(() => true);
    const tunnel = (await startEgressTunnel(h.env, h.deps))!;
    await tunnel.rotate();
    await tunnel.rotate();
    await tunnel.rotate();
    tunnel.stop();
    expect(h.selected).toEqual(["oc-exit-au-2", "oc-exit-au-1", "oc-exit-au-2"]);
  });

  it("skips an exit that fails its probe", async () => {
    const h = harness((tag) => tag !== "oc-exit-au-1");
    const tunnel = (await startEgressTunnel(h.env, h.deps))!;
    // Starts on the healthy exit, then stays there.
    await tunnel.rotate();
    tunnel.stop();
    expect(h.selected).toEqual(["oc-exit-au-2"]);
  });

  it("reports a sing-box that dies", async () => {
    const h = harness(() => true);
    await startEgressTunnel(h.env, h.deps);
    h.child.emit("exit", 1);
    expect(h.exited()).toBe(1);
  });
});
