import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EGRESS_MAX_ENTRIES,
  egressCidr,
  egressDomain,
  parseDeploymentEgress,
  platformEgressDomains,
} from "../src/deployment-egress.js";
import { EGRESS_EXITS, exitCredential, exitIdentity, utcDay } from "../src/egress-exit.js";
import type { AgentDeployment } from "../src/protocol.js";
import type { SandboxEnsureInput } from "../src/platform/sandbox-adapter.js";
import { modalToolSandbox } from "../src/platform/tool-sandbox/modal.js";
import type {
  ModalPlatformEnv,
  SupervisorRequest,
} from "../src/platform/tool-sandbox/shared.js";

describe("deployment egress (work 057)", () => {
  it("normalizes exact and wildcard domains and rejects everything else", () => {
    expect(egressDomain("API.GitHub.com.")).toBe("api.github.com");
    expect(egressDomain("*.acme.example")).toBe("*.acme.example");
    for (const bad of [
      "*",
      "*.com.",
      "localhost",
      "1.2.3.4",
      "a..b.com",
      "-a.com",
      "a-.com",
      "*.*.a.com",
      "a.com:443",
      "https://a.com",
      "a.com/path",
      "foo.123",
    ]) {
      expect(egressDomain(bad), bad).toBeNull();
    }
  });

  it("turns IPs into host CIDRs and validates prefixes", () => {
    expect(egressCidr("203.0.113.10")).toBe("203.0.113.10/32");
    expect(egressCidr("10.20.0.0/16")).toBe("10.20.0.0/16");
    expect(egressCidr("2001:DB8::1")).toBe("2001:db8::1/128");
    expect(egressCidr("2001:db8::/32")).toBe("2001:db8::/32");
    for (const bad of [
      "256.0.0.1",
      "10.0.0.0/33",
      "2001:db8::/129",
      "10.0.0.0/8/1",
      "10.0.0",
      "example.com",
      "10.0.0.0/",
      "::g",
    ]) {
      expect(egressCidr(bad), bad).toBeNull();
    }
  });

  it("parses, dedupes and sorts; absence is open, invalid is null", () => {
    expect(parseDeploymentEgress(undefined)).toBeUndefined();
    expect(parseDeploymentEgress(null)).toBeUndefined();
    expect(
      parseDeploymentEgress({
        domains: ["b.com", "*.a.com", "B.com"],
        cidrs: ["1.1.1.1", "1.1.1.1/32"],
      }),
    ).toEqual({ domains: ["*.a.com", "b.com"], cidrs: ["1.1.1.1/32"] });
    expect(parseDeploymentEgress({})).toEqual({ domains: [], cidrs: [] });
    expect(parseDeploymentEgress({ domains: ["1.2.3.4"] })).toBeNull();
    expect(parseDeploymentEgress({ cidrs: ["a.com"] })).toBeNull();
    expect(parseDeploymentEgress({ allow: ["a.com"] })).toBeNull();
    expect(parseDeploymentEgress(["a.com"])).toBeNull();
    expect(parseDeploymentEgress({ domains: "a.com" })).toBeNull();
    expect(
      parseDeploymentEgress({
        domains: Array.from({ length: EGRESS_MAX_ENTRIES + 1 }, (_, i) => `h${i}.com`),
      }),
    ).toBeNull();
  });

  it("always opens the edge and the artifact bucket's S3 endpoint", () => {
    expect(platformEgressDomains("https://api.opencomputer.dev/", "us-east-1")).toEqual([
      "api.opencomputer.dev",
      "*.s3.us-east-1.amazonaws.com",
    ]);
  });
});

const deployment = {
  id: "agent:digest",
  agentId: "agent",
  alias: "production",
  runtimeMode: "workerd-lazy-sandbox",
  channels: [],
  connections: [],
  httpConnections: [],
  artifact: { bucket: "bucket", key: "key", digest: "digest", size: 1 },
  imageArn: "arn",
  imageVersion: "1",
} as unknown as AgentDeployment;

function ensureInput(egress?: AgentDeployment["egress"]): SandboxEnsureInput {
  return {
    accountId: "acct",
    sessionID: "ses-1",
    edge: "https://edge.example.com",
    runtimeToken: "rt",
    generation: 1,
    workspace: { id: "ses-1", mountPath: "/workspace" },
    deployment: { ...deployment, ...(egress ? { egress } : {}) },
  };
}

/** Neither provider reaches the supervisor through this on the paths tested. */
const noSupervisor: SupervisorRequest = async () => {
  throw new Error("unexpected supervisor request");
};

const modalEnv = {
  BLUE_SANDBOX_PROVIDER: "modal",
  MODAL_SHIM_URL: "https://shim.example.com",
  MODAL_SHIM_TOKEN: "token",
  BLUE_AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "id",
  AWS_SECRET_ACCESS_KEY: "secret",
} as unknown as ModalPlatformEnv;

/** A shim plus tunnel: records each create body, echoes `echo(body)` as the applied policy. */
function shim(echo: (body: Record<string, unknown>) => unknown) {
  const creates: Record<string, unknown>[] = [];
  const terminated: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/snapshots/")) return Response.json({ image_id: null });
      if (url.endsWith("/sandboxes")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        creates.push(body);
        return Response.json({
          sandbox_id: "sb-1",
          tunnel_url: "https://tunnel.example.com",
          ready_ms: 1,
          outbound_policy: echo(body),
        });
      }
      if (url.endsWith("/sandboxes/sb-1/terminate")) {
        terminated.push("sb-1");
        return Response.json({ terminated: true });
      }
      if (url === "https://tunnel.example.com/health") {
        return Response.json({ toolSandbox: "ready", sessionId: "ses-1", generation: 1 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  return { creates, terminated };
}

describe("Modal ensure with an egress allowlist", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends no allowlists for a deployment without egress", async () => {
    const { creates } = shim(() => null);
    const response = await modalToolSandbox(modalEnv).ensure(ensureInput(), Date.now(), noSupervisor);
    expect(response.status).toBe(201);
    expect(creates[0]).not.toHaveProperty("outbound_domain_allowlist");
    expect(creates[0]).not.toHaveProperty("outbound_cidr_allowlist");
  });

  it("sends the deployment's allowlists plus the platform hosts", async () => {
    const { creates, terminated } = shim((body) => ({
      domains: body.outbound_domain_allowlist,
      cidrs: body.outbound_cidr_allowlist,
    }));
    const response = await modalToolSandbox(modalEnv).ensure(
      ensureInput({ domains: ["*.acme.example"], cidrs: [] }),
      Date.now(),
      noSupervisor,
    );
    expect(response.status).toBe(201);
    expect(creates[0]?.outbound_domain_allowlist).toEqual([
      "*.acme.example",
      "*.s3.us-east-1.amazonaws.com",
      "edge.example.com",
    ]);
    // An empty CIDR list is sent, not omitted: omitted would mean any IP.
    expect(creates[0]?.outbound_cidr_allowlist).toEqual([]);
    expect(terminated).toEqual([]);
  });

  it("terminates and refuses a sandbox whose shim did not confirm the policy", async () => {
    const { terminated } = shim(() => undefined);
    const response = await modalToolSandbox(modalEnv).ensure(
      ensureInput({ domains: ["api.github.com"], cidrs: ["10.0.0.0/8"] }),
      Date.now(),
      noSupervisor,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "egress_unconfirmed" });
    expect(terminated).toEqual(["sb-1"]);
  });

  it("refuses a sandbox that runs a different policy than requested", async () => {
    const { terminated } = shim(() => ({ domains: ["*"], cidrs: ["0.0.0.0/0"] }));
    const response = await modalToolSandbox(modalEnv).ensure(
      ensureInput({ domains: ["api.github.com"], cidrs: [] }),
      Date.now(),
      noSupervisor,
    );
    expect(response.status).toBe(503);
    expect(terminated).toEqual(["sb-1"]);
  });
});

describe("ensure with fixed IPs (work 073)", () => {
  afterEach(() => vi.unstubAllGlobals());

  for (const [name, provider, status, code] of [
    ["Modal without a root key", () => modalToolSandbox(modalEnv), 503, "fixed_ips_unavailable"],
  ] as const) {
    it(`${name}: refuses before starting a sandbox`, async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const input = ensureInput();
      input.deployment = { ...input.deployment, fixedIps: "au" };
      const response = await provider().ensure(input, Date.now(), noSupervisor);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }
});

describe("Modal ensure with fixed IPs (work 073)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const rootKey = "ab".repeat(32);

  function fixedInput(egress?: AgentDeployment["egress"]): SandboxEnsureInput {
    const input = ensureInput(egress);
    input.deployment = { ...input.deployment, fixedIps: "au" };
    return input;
  }

  it("lets the sandbox reach only the region's exits and hands the supervisor its tunnel", async () => {
    const { creates, terminated } = shim((body) => ({
      domains: body.outbound_domain_allowlist,
      cidrs: body.outbound_cidr_allowlist,
    }));
    const input = fixedInput({ domains: ["*.acme.example"], cidrs: [] });
    const response = await modalToolSandbox({ ...modalEnv, EGRESS_ROOT_KEY: rootKey }).ensure(
      input,
      Date.now(),
      noSupervisor,
    );
    expect(response.status).toBe(201);
    expect(terminated).toEqual([]);
    // The exits enforce the deployment's allowlist; Modal's holds only them.
    expect(creates[0]?.outbound_domain_allowlist).toEqual([]);
    expect(creates[0]?.outbound_cidr_allowlist).toEqual(
      EGRESS_EXITS.filter((exit) => exit.region === "au")
        .map((exit) => `${exit.server}/32`)
        .sort(),
    );
    const sandboxEnv = creates[0]?.env as Record<string, string>;
    const client = JSON.parse(sandboxEnv.BLUE_EGRESS_CLIENT!) as {
      outbounds: Array<{ tag: string; uuid?: string; server?: string }>;
    };
    expect(client.outbounds.map((outbound) => outbound.tag)).toEqual(["exit", "oc-exit-au-1", "oc-exit-au-2"]);
    expect(client.outbounds[1]?.uuid).toBe(
      await exitCredential(rootKey, await exitIdentity("acct", input.deployment.id), utcDay()),
    );
    expect(sandboxEnv.BLUE_EGRESS_PROBE_URL).toBe("https://edge.example.com/v1/egress-ips");
  });

  it("terminates a sandbox whose shim did not confirm the exits-only allowlist", async () => {
    const { terminated } = shim(() => null);
    const response = await modalToolSandbox({ ...modalEnv, EGRESS_ROOT_KEY: rootKey }).ensure(
      fixedInput(),
      Date.now(),
      noSupervisor,
    );
    expect(response.status).toBe(503);
    expect(terminated).toEqual(["sb-1"]);
  });
});
