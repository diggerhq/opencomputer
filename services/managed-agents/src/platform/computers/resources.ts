// What an organization's computer is, in Azure (work 052, "What a computer
// is, in Azure"; ported from dash-cal src/computer.ts): resource names, the
// ARM bodies of its data disk, NIC and VM, and the cloud-init in the VM's
// customData. Pure. Only the platform Worker uses this module; the edge never
// sees a resource id, region or VM size beyond the size it asked for.
//
// Parking (decision 10) deletes the VM and NIC and keeps both disks, so the
// OS disk's deleteOption is Detach; waking PUTs the VM again attaching the
// kept OS disk (createOption Attach: no image, no osProfile, no customData).

import { computerName, isPoolId, ownerTag, validResourcePrefix } from "../../computer/names.js";
import { API_VERSIONS, type AzureCredentials } from "./arm.js";

export { computerName, validOrganizationId, validResourcePrefix } from "../../computer/names.js";

/** Azure placement and Calvin bootstrap settings: platform Worker vars and secrets. */
export interface ComputerPlatformEnv {
  AZURE_TENANT_ID?: string;
  AZURE_CLIENT_ID?: string;
  AZURE_CLIENT_SECRET?: string;
  AZURE_SUBSCRIPTION_ID?: string;
  AZURE_COMPUTER_RESOURCE_GROUP?: string;
  AZURE_COMPUTER_REGION?: string;
  AZURE_COMPUTER_SUBNET_ID?: string;
  AZURE_COMPUTER_IDENTITY_ID?: string;
  AZURE_COMPUTER_IDENTITY_CLIENT_ID?: string;
  COMPUTER_BOOTSTRAP_URL?: string;
  /** Calvin's telemetry collector (work 054), e.g. https://telemetry.opencomputer.dev; unset: hosts send nothing. */
  COMPUTER_TELEMETRY_URL?: string;
}

export interface ComputerPlacement {
  subscriptionId: string;
  resourceGroup: string;
  region: string;
  /** The computers' subnet (NAT gateway for egress, NSG denying inbound). */
  subnetId: string;
  /** The `computer-bootstrap` user-assigned identity, and its client id. */
  identityId: string;
  identityClientId: string;
  /** Calvin's latest release bundle, readable by that identity. */
  bootstrapUrl: string;
  /** Where hosts send telemetry; optional, unlike the rest. */
  telemetryUrl?: string;
}

export class ComputersNotConfigured extends Error {
  constructor(readonly missing: string[]) {
    super(`computers are not configured: missing ${missing.join(", ")}`);
    this.name = "ComputersNotConfigured";
  }
}

const PLACEMENT_KEYS = [
  "AZURE_SUBSCRIPTION_ID",
  "AZURE_COMPUTER_RESOURCE_GROUP",
  "AZURE_COMPUTER_REGION",
  "AZURE_COMPUTER_SUBNET_ID",
  "AZURE_COMPUTER_IDENTITY_ID",
  "AZURE_COMPUTER_IDENTITY_CLIENT_ID",
  "COMPUTER_BOOTSTRAP_URL",
] as const;
const CREDENTIAL_KEYS = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"] as const;

/** Every setting the platform still lacks, by name (never by value). */
export function missingPlatformConfig(env: ComputerPlatformEnv): string[] {
  return [...CREDENTIAL_KEYS, ...PLACEMENT_KEYS].filter((name) => !env[name]);
}

export function computerPlacement(env: ComputerPlatformEnv): ComputerPlacement {
  const missing = PLACEMENT_KEYS.filter((name) => !env[name]);
  if (missing.length) throw new ComputersNotConfigured(missing);
  return {
    subscriptionId: env.AZURE_SUBSCRIPTION_ID!,
    resourceGroup: env.AZURE_COMPUTER_RESOURCE_GROUP!,
    region: env.AZURE_COMPUTER_REGION!,
    subnetId: env.AZURE_COMPUTER_SUBNET_ID!,
    identityId: env.AZURE_COMPUTER_IDENTITY_ID!,
    identityClientId: env.AZURE_COMPUTER_IDENTITY_CLIENT_ID!,
    bootstrapUrl: env.COMPUTER_BOOTSTRAP_URL!,
    ...(env.COMPUTER_TELEMETRY_URL ? { telemetryUrl: env.COMPUTER_TELEMETRY_URL } : {}),
  };
}

export function azureCredentials(env: ComputerPlatformEnv): AzureCredentials {
  const missing = CREDENTIAL_KEYS.filter((name) => !env[name]);
  if (missing.length) throw new ComputersNotConfigured(missing);
  return {
    tenantId: env.AZURE_TENANT_ID!,
    clientId: env.AZURE_CLIENT_ID!,
    clientSecret: env.AZURE_CLIENT_SECRET!,
  };
}

export const OS_DISK_GIB = 64;
/**
 * Premium SSD v2 performance, well above its free baseline (3,000 IOPS,
 * 125 MB/s): clones, installs and builds on /data are disk-bound. Within a
 * 128 GiB disk's limits (500 IOPS per GiB) and a D16as_v7's uncached caps.
 * Smaller disks get what their size allows, never below the baseline.
 */
const DATA_DISK_IOPS = 20_000;
const DATA_DISK_IOPS_PER_GIB = 500;
const DATA_DISK_BASELINE_IOPS = 3_000;
const DATA_DISK_MBPS = 600;
const ADMIN_USER = "azureuser";
const MAX_DISK_GIB = 65_536;

/** v6 and v7 sizes (e.g. `Standard_D2as_v7`) expose disks only over NVMe. */
export function nvmeSize(size: string): boolean {
  return /_v[67]$/i.test(size);
}

export function validSize(size: string): boolean {
  return /^Standard_[A-Za-z0-9_]+$/.test(size);
}

export function validDiskGiB(diskGiB: number): boolean {
  return Number.isInteger(diskGiB) && diskGiB >= 1 && diskGiB <= MAX_DISK_GIB;
}

/** Where the data disk at LUN 0 appears on the VM (Azure's udev rules). */
export function dataDevice(size: string): string {
  return nvmeSize(size) ? "/dev/disk/azure/data/by-lun/0" : "/dev/disk/azure/scsi1/lun0";
}

export type ComputerResourceKind = "vm" | "nic" | "dataDisk" | "osDisk";

export interface ComputerResources {
  name: string;
  vm: string;
  nic: string;
  dataDisk: string;
  osDisk: string;
}

/**
 * The ids of a computer's resources from its name prefix (stored on the
 * edge's lifecycle row; names.ts), or from an organization id for callers
 * that predate the stored prefix.
 */
export function computerResources(placement: ComputerPlacement, prefix: string | { organizationId: string }): ComputerResources {
  const name = typeof prefix === "string" ? prefix : computerName(prefix.organizationId);
  if (!validResourcePrefix(name)) throw new Error(`invalid resource prefix: ${name}`);
  const group = `/subscriptions/${placement.subscriptionId}/resourceGroups/${placement.resourceGroup}`;
  return {
    name,
    vm: `${group}/providers/Microsoft.Compute/virtualMachines/${name}`,
    nic: `${group}/providers/Microsoft.Network/networkInterfaces/${name}-nic`,
    dataDisk: `${group}/providers/Microsoft.Compute/disks/${name}-data`,
    osDisk: `${group}/providers/Microsoft.Compute/disks/${name}-os`,
  };
}

export const RESOURCE_API: Record<ComputerResourceKind, string> = {
  vm: API_VERSIONS.virtualMachines,
  nic: API_VERSIONS.networkInterfaces,
  dataDisk: API_VERSIONS.disks,
  osDisk: API_VERSIONS.disks,
};

/**
 * A computer's tags. A warm pool computer (`pool-<random>`) is tagged
 * `organization=pool` and `pool-slot=<id>` until a claim moves it to an
 * organization (`claimTags`, routes.ts).
 */
export function computerTags(organizationId: string): Record<string, string> {
  return {
    role: "calvin-host",
    organization: ownerTag(organizationId),
    "managed-by": "managed-agents",
    ...(isPoolId(organizationId) ? { "pool-slot": organizationId } : {}),
  };
}

export function dataDiskIops(diskGiB: number): number {
  return Math.max(DATA_DISK_BASELINE_IOPS, Math.min(DATA_DISK_IOPS, diskGiB * DATA_DISK_IOPS_PER_GIB));
}

export function dataDiskBody(
  placement: ComputerPlacement,
  spec: { organizationId: string; diskGiB: number; zone: string },
): unknown {
  return {
    location: placement.region,
    zones: [spec.zone],
    sku: { name: "PremiumV2_LRS" },
    tags: computerTags(spec.organizationId),
    properties: {
      diskSizeGB: spec.diskGiB,
      diskIOPSReadWrite: dataDiskIops(spec.diskGiB),
      diskMBpsReadWrite: DATA_DISK_MBPS,
      creationData: { createOption: "Empty" },
    },
  };
}

/** A private address in the computers' subnet and nothing else: no public IP. */
export function nicBody(placement: ComputerPlacement, spec: { organizationId: string }): unknown {
  return {
    location: placement.region,
    tags: computerTags(spec.organizationId),
    properties: {
      enableAcceleratedNetworking: true,
      ipConfigurations: [
        {
          name: "primary",
          properties: {
            primary: true,
            privateIPAllocationMethod: "Dynamic",
            subnet: { id: placement.subnetId },
          },
        },
      ],
    },
  };
}

export interface VmSpec {
  organizationId: string;
  /** Resource name prefix (names.ts). */
  prefix: string;
  size: string;
  zone: string;
  /** "create": a fresh OS disk from the image, with first-boot customData. "attach": wake on the kept OS disk. */
  mode: "create" | "attach";
  /** OpenSSH public key nobody holds the private half of (Azure requires one key without passwords). */
  sshPublicKey: string;
  /** create only: where the host dials, and its token. */
  gatewayUrl?: string;
  hostToken?: string;
}

export function vmBody(placement: ComputerPlacement, spec: VmSpec): unknown {
  const resources = computerResources(placement, spec.prefix);
  const attach = spec.mode === "attach";
  // Both disks and the NIC outlive the VM: parking deletes only the VM.
  const osDisk = attach
    ? {
        name: `${resources.name}-os`,
        osType: "Linux",
        createOption: "Attach",
        caching: "ReadWrite",
        managedDisk: { id: resources.osDisk },
        deleteOption: "Detach",
      }
    : {
        name: `${resources.name}-os`,
        createOption: "FromImage",
        caching: "ReadWrite",
        diskSizeGB: OS_DISK_GIB,
        managedDisk: { storageAccountType: "StandardSSD_LRS" },
        deleteOption: "Detach",
      };
  let osProfile: unknown;
  if (!attach) {
    if (!spec.gatewayUrl || !spec.hostToken) throw new Error("creating a VM needs its gateway URL and host token");
    osProfile = {
      computerName: resources.name,
      adminUsername: ADMIN_USER,
      customData: customData(
        cloudInit(placement, {
          organizationId: spec.organizationId,
          size: spec.size,
          gatewayUrl: spec.gatewayUrl,
          hostToken: spec.hostToken,
        }),
      ),
      linuxConfiguration: {
        disablePasswordAuthentication: true,
        provisionVMAgent: true,
        ssh: {
          publicKeys: [{ path: `/home/${ADMIN_USER}/.ssh/authorized_keys`, keyData: spec.sshPublicKey }],
        },
      },
    };
  }
  return {
    location: placement.region,
    zones: [spec.zone],
    tags: computerTags(spec.organizationId),
    identity: { type: "UserAssigned", userAssignedIdentities: { [placement.identityId]: {} } },
    properties: {
      hardwareProfile: { vmSize: spec.size },
      storageProfile: {
        ...(attach
          ? {}
          : { imageReference: { publisher: "Canonical", offer: "ubuntu-24_04-lts", sku: "server", version: "latest" } }),
        osDisk,
        dataDisks: [
          {
            lun: 0,
            createOption: "Attach",
            caching: "None",
            managedDisk: { id: resources.dataDisk },
            deleteOption: "Detach",
          },
        ],
        ...(nvmeSize(spec.size) ? { diskControllerType: "NVMe" } : {}),
      },
      ...(osProfile ? { osProfile } : {}),
      networkProfile: {
        networkInterfaces: [{ id: resources.nic, properties: { primary: true, deleteOption: "Detach" } }],
      },
      diagnosticsProfile: { bootDiagnostics: { enabled: true } },
    },
  };
}

/**
 * The VM's first-boot cloud-init, exactly the contract in the header of
 * Calvin's deploy/vm/azure-computer-boot.sh: a root-only env file, then fetch
 * Calvin's release bundle with the managed identity and exec the boot script
 * from the clone, which copies the SP_* keys into host.env. The host token is in here: customData is readable only by
 * root on the VM and Calvin blocks the metadata service for the agent user.
 */
export function cloudInit(
  placement: ComputerPlacement,
  spec: { organizationId: string; size: string; gatewayUrl: string; hostToken: string },
): string {
  const env: Array<[string, string]> = [
    ["SP_GATEWAY_URL", spec.gatewayUrl],
    ["SP_HOST_TOKEN", spec.hostToken],
    ["SP_HOST_ID", spec.organizationId],
    ["DATA_DEVICE", dataDevice(spec.size)],
    ["BOOTSTRAP_URL", placement.bootstrapUrl],
    ["CLIENT_ID", placement.identityClientId],
    // Telemetry dimensions and collector (work 054). The host's collector
    // credential is not here: the gateway sends it in `welcome`.
    ["SP_REGION", placement.region],
    ["SP_SUBSTRATE", "vm"],
    ...(placement.telemetryUrl ? [["SP_TELEMETRY_URL", placement.telemetryUrl] as [string, string]] : []),
  ];
  for (const [name, value] of env) {
    // Unquoted KEY=value lines, parsed (not sourced) on the VM: nothing that could break out.
    if (!/^[A-Za-z0-9_.:/?=&%~+-]*$/.test(value)) throw new Error(`${name} has characters the env file cannot carry`);
  }
  return `#cloud-config
write_files:
  - path: /root/calvin-computer.env
    owner: root:root
    permissions: "0600"
    content: |
${env.map(([name, value]) => `      ${name}=${value}`).join("\n")}
runcmd:
  - - bash
    - -c
    - |
      set -euo pipefail
      exec >>/var/log/calvin-boot.log 2>&1
      # Parsed, not sourced: a signed bootstrap URL contains "&".
      while IFS='=' read -r k v; do [ -n "$k" ] && export "$k=$v"; done < /root/calvin-computer.env
      install -d -m 0755 /opt/bootstrap
      case "$BOOTSTRAP_URL" in
        *sig=*)
          # A read-only signed URL (previews): no managed identity needed.
          curl -fsS --retry 10 --retry-delay 5 --retry-all-errors "$BOOTSTRAP_URL" -o /opt/bootstrap/calvin.bundle ;;
        *)
          q="api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F\${CLIENT_ID:+&client_id=$CLIENT_ID}"
          tok=""
          for i in $(seq 60); do
            tok="$(curl -fsS -m 10 -H Metadata:true "http://169.254.169.254/metadata/identity/oauth2/token?$q" \\
              | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')" && break
            sleep 5
          done
          [ -n "$tok" ] || { echo "no managed identity token"; exit 1; }
          curl -fsS --retry 10 --retry-delay 5 --retry-all-errors -H "Authorization: Bearer $tok" \\
            -H 'x-ms-version: 2023-11-03' "$BOOTSTRAP_URL" -o /opt/bootstrap/calvin.bundle
          unset tok ;;
      esac
      rm -rf /opt/bootstrap/calvin-src
      git clone -q --branch main /opt/bootstrap/calvin.bundle /opt/bootstrap/calvin-src
      BOOTSTRAP_FETCH=0 exec bash /opt/bootstrap/calvin-src/deploy/vm/azure-computer-boot.sh
`;
}

export function customData(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
