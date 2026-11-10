// POST /v1/computers/arm on the platform Worker (work 052): the only way the
// edge reaches Azure. Like every platform route it is reachable only through
// the platform service binding (the Worker has no public route and
// workers_dev is off). The operation names an organization and the
// computer's resource name prefix (validated: `oc-` + at most 57 of
// [a-z0-9-]; without one, the name derived from the organization id, which is
// what computers created before the prefix was stored use). Every resource id
// is built here from the prefix and the platform's own placement config, so
// the edge cannot address anything outside the computers' resource group.

import type { CloudOperation, CloudReply, CloudResource, CloudResourceKind } from "../../computer/cloud-contract.js";
import { POOL_TAG, isPoolId } from "../../computer/names.js";
import { ArmError, type ArmResource, AzureClient, type Fetch } from "./arm.js";
import {
  type ComputerPlatformEnv,
  ComputersNotConfigured,
  RESOURCE_API,
  azureCredentials,
  computerPlacement,
  computerResources,
  computerTags,
  dataDiskBody,
  missingPlatformConfig,
  nicBody,
  validDiskGiB,
  computerName,
  validOrganizationId,
  validResourcePrefix,
  validSize,
  vmBody,
} from "./resources.js";

const KINDS = new Set<CloudResourceKind>(["vm", "nic", "dataDisk", "osDisk"]);

function reply(body: CloudReply, status = 200): Response {
  return Response.json(body, { status });
}

function summary(resource: ArmResource | null): CloudResource | null {
  if (!resource) return null;
  const statuses = resource.properties?.instanceView?.statuses ?? [];
  const failure = statuses.find((s) => s.code?.startsWith("ProvisioningState/failed"));
  return {
    provisioningState: resource.properties?.provisioningState ?? null,
    organization: resource.tags?.organization ?? null,
    ...(resource.properties?.hardwareProfile?.vmSize !== undefined
      ? { vmSize: resource.properties.hardwareProfile.vmSize }
      : {}),
    ...(resource.properties?.diskSizeGB !== undefined ? { diskSizeGB: resource.properties.diskSizeGB } : {}),
    ...(failure ? { failure: failure.message ?? failure.code ?? null } : {}),
  };
}

function invalid(message: string): Response {
  return reply({ ok: false, error: { status: 400, code: "invalid_request", message } }, 400);
}

export async function handleComputerArmRequest(
  request: Request,
  env: ComputerPlatformEnv,
  fetcher?: Fetch,
): Promise<Response> {
  let operation: CloudOperation;
  try {
    operation = (await request.json()) as CloudOperation;
  } catch {
    return invalid("expected a JSON operation");
  }
  if (operation.op === "check") return reply({ ok: true, missing: missingPlatformConfig(env) });
  if (!operation || typeof operation !== "object" || !validOrganizationId(String(operation.organizationId ?? ""))) {
    return invalid("invalid organizationId");
  }
  if (operation.prefix !== undefined && !validResourcePrefix(String(operation.prefix))) return invalid("invalid prefix");
  const prefix = operation.prefix ?? computerName(operation.organizationId);
  try {
    const placement = computerPlacement(env);
    const arm = new AzureClient(azureCredentials(env), fetcher);
    const ids = computerResources(placement, prefix);
    switch (operation.op) {
      case "get": {
        if (!KINDS.has(operation.kind)) return invalid("invalid kind");
        const resource = await arm.get(
          ids[operation.kind],
          RESOURCE_API[operation.kind],
          operation.instanceView && operation.kind === "vm" ? { $expand: "instanceView" } : {},
        );
        return reply({ ok: true, resource: summary(resource) });
      }
      case "putDataDisk": {
        if (!validDiskGiB(operation.diskGiB)) return invalid("invalid disk size");
        if (!["1", "2", "3"].includes(operation.zone)) return invalid("invalid zone");
        const resource = await arm.put(ids.dataDisk, RESOURCE_API.dataDisk, dataDiskBody(placement, operation));
        return reply({ ok: true, resource: summary(resource) });
      }
      case "putNic": {
        const resource = await arm.put(ids.nic, RESOURCE_API.nic, nicBody(placement, operation));
        return reply({ ok: true, resource: summary(resource) });
      }
      case "putVm": {
        if (!validSize(operation.size)) return invalid("invalid size");
        if (!["1", "2", "3"].includes(operation.zone)) return invalid("invalid zone");
        if (operation.mode !== "create" && operation.mode !== "attach") return invalid("invalid mode");
        const resource = await arm.put(ids.vm, RESOURCE_API.vm, vmBody(placement, { ...operation, prefix }));
        return reply({ ok: true, resource: summary(resource) });
      }
      case "resizeVm": {
        if (!validSize(operation.size)) return invalid("invalid size");
        const resource = await arm.patch(ids.vm, RESOURCE_API.vm, {
          properties: { hardwareProfile: { vmSize: operation.size } },
        });
        return reply({ ok: true, resource: summary(resource) });
      }
      case "growDataDisk": {
        if (!validDiskGiB(operation.diskGiB)) return invalid("invalid disk size");
        const resource = await arm.patch(ids.dataDisk, RESOURCE_API.dataDisk, {
          properties: { diskSizeGB: operation.diskGiB },
        });
        return reply({ ok: true, resource: summary(resource) });
      }
      case "tagOsDisk": {
        // A VM PUT cannot tag the OS disk it creates; tag it afterwards so
        // the ownership check and Calvin's update tooling recognise it.
        const resource = await arm.patch(ids.osDisk, RESOURCE_API.osDisk, {
          tags: computerTags(operation.organizationId),
        });
        return reply({ ok: true, resource: summary(resource) });
      }
      case "claimTags": {
        // The one place a resource's owner changes: only from the pool to
        // an organization. Every resource is checked before any is changed.
        if (isPoolId(operation.organizationId)) return invalid("a pool computer cannot be claimed by the pool");
        const kinds = ["vm", "nic", "dataDisk", "osDisk"] as const;
        const found: Array<{ kind: (typeof kinds)[number]; resource: ArmResource }> = [];
        for (const kind of kinds) {
          const resource = await arm.get(ids[kind], RESOURCE_API[kind]);
          if (!resource) continue;
          const owner = resource.tags?.organization;
          if (owner !== undefined && owner !== POOL_TAG && owner !== operation.organizationId) {
            return reply(
              { ok: false, error: { status: 409, code: "not_claimable", message: `${kind} is tagged for ${owner}, not the pool` } },
              409,
            );
          }
          found.push({ kind, resource });
        }
        for (const { kind, resource } of found) {
          if (resource.tags?.organization === operation.organizationId) continue;
          const { "pool-slot": slot, ...kept } = resource.tags ?? {};
          await arm.patch(ids[kind], RESOURCE_API[kind], {
            tags: { ...kept, ...computerTags(operation.organizationId), ...(slot ? { "claimed-from": slot } : {}) },
          });
        }
        return reply({ ok: true, moved: found.length });
      }
      case "delete": {
        if (!KINDS.has(operation.kind)) return invalid("invalid kind");
        const deleted = await arm.delete(ids[operation.kind], RESOURCE_API[operation.kind]);
        return reply({ ok: true, deleted });
      }
      default:
        return invalid("unknown op");
    }
  } catch (error) {
    if (error instanceof ComputersNotConfigured) {
      return reply({ ok: false, error: { status: 503, code: "not_configured", message: error.message } }, 503);
    }
    if (error instanceof ArmError) {
      return reply({ ok: false, error: { status: error.status, code: error.code, message: error.message } }, 502);
    }
    if (error instanceof Error && /^(invalid organization id|creating a VM needs|.* has characters)/.test(error.message)) {
      return invalid(error.message);
    }
    throw error;
  }
}
