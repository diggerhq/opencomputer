/**
 * Fixed egress IPs in the sandbox (work 073). When the
 * platform passes BLUE_EGRESS_CLIENT, every IPv4 connection leaves through
 * sing-box's TUN to one of the region's exits (`deploy/egress/`). Modal lets
 * the sandbox reach only the exits, so without the tunnel nothing leaves.
 *
 * The supervisor starts the tunnel before it listens, probes the exits in
 * the background, and moves to the next healthy exit before each new tool
 * operation, so tool calls round-robin across the region's IPs. Open
 * connections stay on the exit they started on.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { EXIT_CONTROLLER, EXIT_SELECTOR } from "../egress-exit.js";

const CONFIG_PATH = "/run/blue-egress/client.json";
const START_TIMEOUT_MS = 20_000;
const PROBE_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const SWITCH_TIMEOUT_MS = 1_000;

export interface EgressTunnel {
  /** The exit tags, in round-robin order. */
  readonly exits: readonly string[];
  /** Selects the next healthy exit; keeps the current one if none is known. */
  rotate(): Promise<void>;
  stop(): void;
}

export interface EgressTunnelDeps {
  fetch: typeof fetch;
  readRoutes: () => Promise<string>;
  writeConfig: (path: string, contents: string) => Promise<void>;
  spawnSingBox: (configPath: string) => ChildProcess;
  log: (event: Record<string, unknown>) => void;
  /** Called when sing-box exits; the sandbox has no network after that. */
  onExit: (code: number | null) => void;
}

const defaultDeps: EgressTunnelDeps = {
  fetch: (input, init) => fetch(input, init),
  readRoutes: () => readFile("/proc/net/route", "utf8"),
  writeConfig: async (path, contents) => {
    await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await writeFile(path, contents, { mode: 0o600 });
  },
  spawnSingBox: (configPath) =>
    spawn("sing-box", ["run", "-c", configPath], { stdio: ["ignore", "inherit", "inherit"] }),
  log: (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
  onExit: () => process.exit(1),
};

/**
 * The IPv4 subnets the sandbox's own interfaces sit on, from
 * `/proc/net/route`. They stay outside the tunnel: Modal delivers inbound
 * tunnel traffic from the interface's gateway, and replies routed into the
 * TUN would never reach it.
 */
export function connectedSubnets(routes: string): string[] {
  const subnets = new Set<string>();
  for (const line of routes.split("\n").slice(1)) {
    const [iface, destination, gateway, flags, , , , mask] = line.trim().split(/\s+/);
    if (!iface || !destination || !mask || iface === "lo" || iface.startsWith("tun")) continue;
    // Up, on-link (no RTF_GATEWAY 0x2), a network (no RTF_HOST 0x4), not default.
    if (gateway !== "00000000" || (Number.parseInt(flags ?? "0", 16) & 0x7) !== 0x1) continue;
    if (mask === "00000000") continue;
    const address = (hex: string) =>
      [0, 2, 4, 6].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).reverse();
    const prefix = address(mask).reduce((bits, byte) => bits + byte.toString(2).replace(/0/g, "").length, 0);
    subnets.add(`${address(destination).join(".")}/${String(prefix)}`);
  }
  return [...subnets].sort();
}

interface ClientConfig {
  inbounds: Array<{ type: string; route_exclude_address?: string[] }>;
  outbounds: Array<{ type: string; tag: string; outbounds?: string[] }>;
  experimental?: Record<string, unknown>;
}

/**
 * Starts the tunnel when the platform asked for one, or returns null. Throws
 * when no exit answers within START_TIMEOUT_MS: a supervisor without a
 * network must not report ready.
 */
export async function startEgressTunnel(
  env: Readonly<Record<string, string | undefined>>,
  deps: EgressTunnelDeps = defaultDeps,
): Promise<EgressTunnel | null> {
  const raw = env.BLUE_EGRESS_CLIENT;
  if (!raw) return null;
  const probeUrl = env.BLUE_EGRESS_PROBE_URL;
  if (!probeUrl) throw new Error("BLUE_EGRESS_PROBE_URL is required with BLUE_EGRESS_CLIENT");
  const config = JSON.parse(raw) as ClientConfig;
  const exits = config.outbounds.find((outbound) => outbound.tag === EXIT_SELECTOR)?.outbounds ?? [];
  if (exits.length === 0) throw new Error("BLUE_EGRESS_CLIENT has no exits");
  const subnets = connectedSubnets(await deps.readRoutes());
  for (const inbound of config.inbounds) {
    if (inbound.type === "tun") {
      inbound.route_exclude_address = [...new Set([...(inbound.route_exclude_address ?? []), ...subnets])];
    }
  }
  // The controller is where this module looks for it, whatever the config said.
  config.experimental = { ...config.experimental, clash_api: { external_controller: EXIT_CONTROLLER } };
  await deps.writeConfig(CONFIG_PATH, JSON.stringify(config));

  let stopping = false;
  const child = deps.spawnSingBox(CONFIG_PATH);
  // A missing binary (an image without sing-box) is an error, not an exit.
  child.once("error", (error) => {
    if (stopping) return;
    deps.log({ level: "error", event: "supervisor.egress_tunnel_failed", message: error.message });
    deps.onExit(null);
  });
  child.once("exit", (code) => {
    if (stopping) return;
    deps.log({ level: "error", event: "supervisor.egress_tunnel_exited", code });
    deps.onExit(code);
  });

  const controller = `http://${EXIT_CONTROLLER}`;
  const healthy = new Set<string>();
  let current = exits[0]!;

  const probe = async (tag: string): Promise<void> => {
    try {
      const response = await deps.fetch(
        `${controller}/proxies/${encodeURIComponent(tag)}/delay?timeout=${String(PROBE_TIMEOUT_MS)}&url=${encodeURIComponent(probeUrl)}`,
        { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS + 1_000) },
      );
      if (response.ok) healthy.add(tag);
      else healthy.delete(tag);
    } catch {
      healthy.delete(tag);
    }
  };
  const probeAll = () => Promise.all(exits.map(probe));

  const select = async (tag: string): Promise<void> => {
    const response = await deps.fetch(`${controller}/proxies/${EXIT_SELECTOR}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: tag }),
      signal: AbortSignal.timeout(SWITCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`exit switch answered ${String(response.status)}`);
    current = tag;
  };

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (healthy.size === 0) {
    if (Date.now() > deadline) {
      stopping = true;
      child.kill();
      throw new Error("no egress exit answered");
    }
    await probeAll();
    if (healthy.size === 0) await new Promise((wake) => setTimeout(wake, 500));
  }
  if (!healthy.has(current)) await select(exits.find((tag) => healthy.has(tag))!);
  deps.log({ level: "info", event: "supervisor.egress_tunnel_ready", exits, healthy: [...healthy], subnets });

  const timer = setInterval(() => void probeAll(), PROBE_INTERVAL_MS);
  timer.unref();

  return {
    exits,
    async rotate() {
      const start = exits.indexOf(current);
      for (let step = 1; step <= exits.length; step += 1) {
        const next = exits[(start + step) % exits.length]!;
        if (!healthy.has(next)) continue;
        if (next === current) return;
        try {
          await select(next);
        } catch (error) {
          // The current exit still works; a failed switch costs only the spread.
          deps.log({
            level: "warn",
            event: "supervisor.egress_switch_failed",
            exit: next,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
    },
    stop() {
      stopping = true;
      clearInterval(timer);
      child.kill();
    },
  };
}
