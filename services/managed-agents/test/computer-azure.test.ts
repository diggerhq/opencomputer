import { describe, expect, it } from "vitest";

import { ArmError, AzureClient, armRequest, tokenRequest } from "../src/platform/computers/arm.js";
import {
  type ComputerPlacement,
  cloudInit,
  computerName,
  computerPlacement,
  computerResources,
  dataDiskBody,
  missingPlatformConfig,
  nicBody,
  vmBody,
} from "../src/platform/computers/resources.js";
import { handleComputerArmRequest } from "../src/platform/computers/routes.js";

const PLACEMENT: ComputerPlacement = {
  subscriptionId: "sub",
  resourceGroup: "rg",
  region: "eastus",
  subnetId: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Network/virtualNetworks/v/subnets/computers",
  identityId: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/computer-bootstrap",
  identityClientId: "client-id",
  bootstrapUrl: "https://example.blob.core.windows.net/bootstrap/calvin-latest.bundle",
};

const ENV = {
  AZURE_TENANT_ID: "tenant",
  AZURE_CLIENT_ID: "client",
  AZURE_CLIENT_SECRET: "client-secret-must-not-leak",
  AZURE_SUBSCRIPTION_ID: PLACEMENT.subscriptionId,
  AZURE_COMPUTER_RESOURCE_GROUP: PLACEMENT.resourceGroup,
  AZURE_COMPUTER_REGION: PLACEMENT.region,
  AZURE_COMPUTER_SUBNET_ID: PLACEMENT.subnetId,
  AZURE_COMPUTER_IDENTITY_ID: PLACEMENT.identityId,
  AZURE_COMPUTER_IDENTITY_CLIENT_ID: PLACEMENT.identityClientId,
  COMPUTER_BOOTSTRAP_URL: PLACEMENT.bootstrapUrl,
};

const ORG = "org_01HXYZ";
const GATEWAY = `wss://managedagents.example/v1/computer/host?organizationId=${ORG}`;

type Body = Record<string, any>;

describe("computer resources in Azure", () => {
  it("names resources from the organization id", () => {
    expect(computerName("org_01HXYZ")).toBe("oc-org-01hxyz");
    expect(computerName(`org_${"a".repeat(80)}`)).toMatch(/^oc-org-a+-[0-9a-f]{8}$/);
    expect(computerName(`org_${"a".repeat(80)}`).length).toBeLessThanOrEqual(60);
    expect(() => computerName("../x")).toThrow();
    const ids = computerResources(PLACEMENT, { organizationId: ORG });
    expect(computerResources(PLACEMENT, "oc-org-01hxyz")).toEqual(ids);
    expect(() => computerResources(PLACEMENT, "oc-../x")).toThrow();
    expect(ids.osDisk).toBe("/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/disks/oc-org-01hxyz-os");
    expect(ids.dataDisk).toMatch(/disks\/oc-org-01hxyz-data$/);
  });

  it("builds a Premium SSD v2 data disk and a NIC without public IP, tagged for the organization", () => {
    const disk = dataDiskBody(PLACEMENT, { organizationId: ORG, diskGiB: 128, zone: "1" }) as Body;
    expect(disk.sku).toEqual({ name: "PremiumV2_LRS" });
    expect(disk.zones).toEqual(["1"]);
    expect(disk.tags).toMatchObject({ role: "calvin-host", organization: ORG });
    expect(disk.properties.diskSizeGB).toBe(128);
    expect(disk.properties.diskIOPSReadWrite).toBe(20_000);
    const nic = nicBody(PLACEMENT, { organizationId: ORG }) as Body;
    expect(JSON.stringify(nic)).not.toMatch(/publicIPAddress/);
    expect(nic.properties.ipConfigurations[0].properties.subnet.id).toBe(PLACEMENT.subnetId);
  });

  it("keeps a small data disk's IOPS within what its size allows", () => {
    const iops = (diskGiB: number) =>
      (dataDiskBody(PLACEMENT, { organizationId: ORG, diskGiB, zone: "1" }) as Body).properties.diskIOPSReadWrite;
    expect(iops(32)).toBe(16_000);
    expect(iops(4)).toBe(3_000);
  });

  it("creates the VM from the image with first-boot cloud-init, keeping both disks when the VM goes", () => {
    const vm = vmBody(PLACEMENT, {
      organizationId: ORG,
      prefix: computerName(ORG),
      size: "Standard_D2as_v7",
      zone: "1",
      mode: "create",
      sshPublicKey: "ssh-rsa AAAA",
      gatewayUrl: GATEWAY,
      hostToken: "sph_token",
    }) as Body;
    const storage = vm.properties.storageProfile;
    expect(storage.imageReference).toMatchObject({ publisher: "Canonical", offer: "ubuntu-24_04-lts" });
    expect(storage.osDisk).toMatchObject({ createOption: "FromImage", deleteOption: "Detach", name: "oc-org-01hxyz-os" });
    expect(storage.dataDisks[0]).toMatchObject({ lun: 0, createOption: "Attach", deleteOption: "Detach" });
    expect(storage.diskControllerType).toBe("NVMe");
    expect(vm.properties.networkProfile.networkInterfaces[0].properties.deleteOption).toBe("Detach");
    expect(vm.identity.userAssignedIdentities).toHaveProperty([PLACEMENT.identityId]);
    const init = atob(vm.properties.osProfile.customData);
    expect(init.startsWith("#cloud-config\n")).toBe(true);
    expect(init).toContain("path: /root/calvin-computer.env");
    expect(init).toContain('permissions: "0600"');
    for (const line of [
      `SP_GATEWAY_URL=${GATEWAY}`,
      "SP_HOST_TOKEN=sph_token",
      `SP_HOST_ID=${ORG}`,
      "DATA_DEVICE=/dev/disk/azure/data/by-lun/0",
      `BOOTSTRAP_URL=${PLACEMENT.bootstrapUrl}`,
      "CLIENT_ID=client-id",
      "SP_REGION=eastus",
      "SP_SUBSTRATE=vm",
    ]) {
      expect(init).toContain(`      ${line}\n`);
    }
    expect(init).not.toContain("SP_TELEMETRY_URL");
    expect(init).toContain("${CLIENT_ID:+&client_id=$CLIENT_ID}");
    expect(init).toContain("BOOTSTRAP_FETCH=0 exec bash /opt/bootstrap/calvin-src/deploy/vm/azure-computer-boot.sh");
  });

  it("wakes by attaching the kept OS disk: no image, no osProfile, no customData", () => {
    const vm = vmBody(PLACEMENT, { organizationId: ORG, prefix: computerName(ORG), size: "Standard_D2as_v7", zone: "1", mode: "attach", sshPublicKey: "ssh-rsa AAAA" }) as Body;
    const storage = vm.properties.storageProfile;
    expect(storage.imageReference).toBeUndefined();
    expect(vm.properties.osProfile).toBeUndefined();
    expect(JSON.stringify(vm)).not.toContain("customData");
    expect(storage.osDisk).toEqual({
      name: "oc-org-01hxyz-os",
      osType: "Linux",
      createOption: "Attach",
      caching: "ReadWrite",
      managedDisk: { id: computerResources(PLACEMENT, "oc-org-01hxyz").osDisk },
      deleteOption: "Detach",
    });
    expect(storage.dataDisks[0].managedDisk.id).toBe(computerResources(PLACEMENT, "oc-org-01hxyz").dataDisk);
  });

  it("points the host at the telemetry collector only when one is configured", () => {
    const init = cloudInit(
      { ...PLACEMENT, telemetryUrl: "https://telemetry.example" },
      { organizationId: ORG, size: "Standard_D2as_v7", gatewayUrl: GATEWAY, hostToken: "t" },
    );
    expect(init).toContain("      SP_TELEMETRY_URL=https://telemetry.example\n");
    expect(computerPlacement({ ...ENV, COMPUTER_TELEMETRY_URL: "https://telemetry.example" }).telemetryUrl).toBe("https://telemetry.example");
    expect(computerPlacement(ENV).telemetryUrl).toBeUndefined();
    expect(missingPlatformConfig({ ...ENV, AZURE_TENANT_ID: "t" })).not.toContain("COMPUTER_TELEMETRY_URL");
  });

  it("uses the SCSI data device on older sizes and refuses values the env file cannot carry", () => {
    expect(cloudInit(PLACEMENT, { organizationId: ORG, size: "Standard_D4ds_v5", gatewayUrl: GATEWAY, hostToken: "t" })).toContain(
      "DATA_DEVICE=/dev/disk/azure/scsi1/lun0",
    );
    expect(() => cloudInit(PLACEMENT, { organizationId: ORG, size: "Standard_D2as_v7", gatewayUrl: GATEWAY, hostToken: "a b\nX=1" })).toThrow();
  });

  it("builds token and ARM requests", async () => {
    const token = tokenRequest({ tenantId: "t", clientId: "c", clientSecret: "s" });
    expect(token.url).toBe("https://login.microsoftonline.com/t/oauth2/v2.0/token");
    expect(await token.text()).toContain("scope=https%3A%2F%2Fmanagement.azure.com%2F.default");
    const get = armRequest("GET", "/subscriptions/s/x", "2024-07-01", "tok", undefined, { $expand: "instanceView" });
    expect(get.url).toBe("https://management.azure.com/subscriptions/s/x?api-version=2024-07-01&%24expand=instanceView");
    expect(() => armRequest("GET", "https://evil", "v", "t")).toThrow();
  });
});

/** A fake management plane behind fetch, recording requests. */
function fakeAzure() {
  const resources = new Map<string, Body>();
  const requests: Array<{ method: string; path: string; body?: Body }> = [];
  let tokens = 0;
  const fetcher = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.host === "login.microsoftonline.com") {
      tokens += 1;
      return Response.json({ access_token: "arm-token", expires_in: 3600 });
    }
    expect(request.headers.get("authorization")).toBe("Bearer arm-token");
    const body = request.method === "PUT" || request.method === "PATCH" ? ((await request.json()) as Body) : undefined;
    requests.push({ method: request.method, path: url.pathname, ...(body ? { body } : {}) });
    const existing = resources.get(url.pathname);
    if (request.method === "GET") return existing ? Response.json(existing) : Response.json({ error: { code: "NotFound" } }, { status: 404 });
    if (request.method === "DELETE") {
      resources.delete(url.pathname);
      return new Response(null, { status: existing ? 202 : 204 });
    }
    if (request.method === "PUT" && url.pathname.endsWith("-nic") && body?.properties?.ipConfigurations?.[0]?.properties?.subnet?.id === "bad") {
      return Response.json({ error: { code: "InvalidSubnet", message: "no such subnet" } }, { status: 400 });
    }
    const next = { ...(existing ?? {}), ...(body ?? {}), properties: { ...(existing?.properties ?? {}), ...(body?.properties ?? {}), provisioningState: "Creating" } };
    resources.set(url.pathname, next);
    return Response.json(next, { status: 201 });
  };
  return { resources, requests, fetcher, tokens: () => tokens };
}

async function call(env: Record<string, string>, operation: Body, fetcher: (request: Request) => Promise<Response>) {
  const response = await handleComputerArmRequest(
    new Request("https://platform/v1/computers/arm", { method: "POST", body: JSON.stringify(operation) }),
    env,
    fetcher,
  );
  return { status: response.status, body: (await response.json()) as Body };
}

describe("platform computer route", () => {
  it("reports what is missing by name, never by value", async () => {
    expect(missingPlatformConfig({})).toContain("AZURE_CLIENT_SECRET");
    const azure = fakeAzure();
    const check = await call({ ...ENV, AZURE_COMPUTER_SUBNET_ID: "" }, { op: "check" }, azure.fetcher);
    expect(check.body).toEqual({ ok: true, missing: ["AZURE_COMPUTER_SUBNET_ID"] });
    const refused = await call({ ...ENV, AZURE_COMPUTER_SUBNET_ID: "" }, { op: "putNic", organizationId: ORG }, azure.fetcher);
    expect(refused.status).toBe(503);
    expect(refused.body.error).toMatchObject({ code: "not_configured", message: "computers are not configured: missing AZURE_COMPUTER_SUBNET_ID" });
  });

  it("derives every resource id itself and answers with the summary the lifecycle reads", async () => {
    const azure = fakeAzure();
    const put = await call(ENV, { op: "putDataDisk", organizationId: ORG, diskGiB: 128, zone: "1" }, azure.fetcher);
    expect(put.body).toEqual({ ok: true, resource: { provisioningState: "Creating", organization: ORG, diskSizeGB: 128 } });
    expect(azure.requests[0]).toMatchObject({ method: "PUT", path: "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/disks/oc-org-01hxyz-data" });
    const got = await call(ENV, { op: "get", organizationId: ORG, kind: "dataDisk" }, azure.fetcher);
    expect(got.body.resource.organization).toBe(ORG);
    expect((await call(ENV, { op: "get", organizationId: ORG, kind: "vm" }, azure.fetcher)).body).toEqual({ ok: true, resource: null });
    await call(ENV, { op: "putVm", organizationId: ORG, size: "Standard_D2as_v7", zone: "1", mode: "attach", sshPublicKey: "k" }, azure.fetcher);
    expect(azure.requests.at(-1)!.body!.properties.storageProfile.osDisk.createOption).toBe("Attach");
    expect((await call(ENV, { op: "delete", organizationId: ORG, kind: "vm" }, azure.fetcher)).body).toEqual({ ok: true, deleted: true });
    expect(azure.tokens()).toBeGreaterThanOrEqual(1);
  });

  it("names resources by the prefix the edge stores, validated at the boundary", async () => {
    const azure = fakeAzure();
    const put = await call(ENV, { op: "putNic", organizationId: ORG, prefix: "oc-pool-k3x9ab" }, azure.fetcher);
    expect(put.status).toBe(200);
    expect(azure.requests.at(-1)!.path).toBe("/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Network/networkInterfaces/oc-pool-k3x9ab-nic");
    // Tags still name the organization, not the prefix.
    expect(azure.requests.at(-1)!.body!.tags.organization).toBe(ORG);
    await call(ENV, { op: "putVm", organizationId: ORG, prefix: "oc-pool-k3x9ab", size: "Standard_D2as_v7", zone: "1", mode: "attach", sshPublicKey: "k" }, azure.fetcher);
    expect(azure.requests.at(-1)!.path).toMatch(/virtualMachines\/oc-pool-k3x9ab$/);
    expect(azure.requests.at(-1)!.body!.properties.storageProfile.osDisk.managedDisk.id).toMatch(/disks\/oc-pool-k3x9ab-os$/);
    for (const kind of ["vm", "dataDisk"]) {
      await call(ENV, { op: "delete", organizationId: ORG, prefix: "oc-pool-k3x9ab", kind }, azure.fetcher);
    }
    expect(azure.requests.slice(-2).map((r) => r.path.split("/").at(-1))).toEqual(["oc-pool-k3x9ab", "oc-pool-k3x9ab-data"]);
    for (const prefix of ["oc-", "../oc-x", "oc-UPPER", "oc-a/b", "x-abc", `oc-${"a".repeat(58)}`, "oc-a b", 42]) {
      const refused = await call(ENV, { op: "get", organizationId: ORG, prefix, kind: "vm" }, azure.fetcher);
      expect(refused.status, String(prefix)).toBe(400);
      expect(refused.body.error).toMatchObject({ code: "invalid_request", message: "invalid prefix" });
    }
    expect((await call(ENV, { op: "get", organizationId: ORG, prefix: `oc-${"a".repeat(57)}`, kind: "vm" }, azure.fetcher)).status).toBe(200);
  });

  it("tags pool computers `pool` and moves a claimed one's tags to the organization, never another's", async () => {
    const azure = fakeAzure();
    const POOL = "pool-k3x9ab12cd34";
    const prefix = computerName(POOL);
    expect(prefix).toBe("oc-pool-k3x9ab12cd34");
    await call(ENV, { op: "putDataDisk", organizationId: POOL, prefix, diskGiB: 128, zone: "1" }, azure.fetcher);
    await call(ENV, { op: "putNic", organizationId: POOL, prefix }, azure.fetcher);
    await call(ENV, { op: "putVm", organizationId: POOL, prefix, size: "Standard_D2as_v7", zone: "1", mode: "create", sshPublicKey: "k", gatewayUrl: GATEWAY, hostToken: "sph_x" }, azure.fetcher);
    expect(azure.requests.at(-1)!.body!.tags).toMatchObject({ organization: "pool", "pool-slot": POOL });
    // The OS disk the VM PUT created (untagged in Azure until tagOsDisk).
    azure.resources.set(`/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Compute/disks/${prefix}-os`, { properties: {} });

    expect((await call(ENV, { op: "claimTags", organizationId: POOL, prefix }, azure.fetcher)).status).toBe(400);
    const moved = await call(ENV, { op: "claimTags", organizationId: ORG, prefix }, azure.fetcher);
    expect(moved.body).toEqual({ ok: true, moved: 4 });
    const patches = azure.requests.filter((r) => r.method === "PATCH");
    expect(patches.map((r) => r.path.split("/").at(-1)).sort()).toEqual([prefix, `${prefix}-data`, `${prefix}-nic`, `${prefix}-os`].sort());
    for (const patch of patches) {
      // The untagged OS disk has no slot to remember.
      const from = patch.path.endsWith("-os") ? {} : { "claimed-from": POOL };
      expect(patch.body).toEqual({ tags: { role: "calvin-host", organization: ORG, "managed-by": "managed-agents", ...from } });
    }
    // Again: already the organization's, nothing to change.
    const before = azure.requests.length;
    expect((await call(ENV, { op: "claimTags", organizationId: ORG, prefix }, azure.fetcher)).body).toEqual({ ok: true, moved: 4 });
    expect(azure.requests.slice(before).filter((r) => r.method === "PATCH")).toEqual([]);
    // Another organization cannot take it: refused before anything changes.
    const refused = await call(ENV, { op: "claimTags", organizationId: "org_other", prefix }, azure.fetcher);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ status: 409, code: "not_claimable" });
    expect(azure.requests.slice(before).filter((r) => r.method === "PATCH")).toEqual([]);
  });

  it("refuses bad input and passes ARM's refusal through without secrets", async () => {
    const azure = fakeAzure();
    expect((await call(ENV, { op: "get", organizationId: "../../x", kind: "vm" }, azure.fetcher)).status).toBe(400);
    expect((await call(ENV, { op: "putVm", organizationId: ORG, size: "rm -rf", zone: "1", mode: "create", sshPublicKey: "k" }, azure.fetcher)).status).toBe(400);
    const failed = await call({ ...ENV, AZURE_COMPUTER_SUBNET_ID: "bad" }, { op: "putNic", organizationId: ORG }, azure.fetcher);
    expect(failed.status).toBe(502);
    expect(failed.body.error).toMatchObject({ status: 400, code: "InvalidSubnet" });
    expect(JSON.stringify(failed.body)).not.toContain(ENV.AZURE_CLIENT_SECRET);
  });

  it("retries sign-in after a 401 and reports network failures as status 0", async () => {
    let fail = true;
    const client = new AzureClient({ tenantId: "t", clientId: "c401", clientSecret: "s" }, async (request) => {
      if (new URL(request.url).host === "login.microsoftonline.com") return Response.json({ access_token: "x", expires_in: 3600 });
      if (fail) {
        fail = false;
        return Response.json({ error: { code: "ExpiredAuthenticationToken" } }, { status: 401 });
      }
      throw new Error("socket hang up");
    });
    await expect(client.get("/subscriptions/s/a", "v")).rejects.toMatchObject({ status: 401 });
    const error = await client.get("/subscriptions/s/a", "v").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArmError);
    expect((error as ArmError).status).toBe(0);
  });
});
