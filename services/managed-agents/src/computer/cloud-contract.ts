// The internal contract between the edge's ComputerDurableObject and the
// platform Worker, which owns the cloud credentials (work 052, decision 6).
// One route, POST /v1/computers/arm on the platform service binding, with a
// JSON operation. The edge names an organization, the computer's resource
// name prefix and what it wants; the platform validates the prefix
// (`oc-` + at most 57 of [a-z0-9-], names.ts) and builds every resource id,
// region and placement itself, so the edge can address nothing outside the
// computers' resource group and nothing about placement crosses back except
// what the lifecycle reads.
//
// `organizationId` is the computer's identity: the `organization` tag, the
// host id in first-boot cloud-init. `prefix` names the resources: stored on
// the lifecycle row since computers can change hands (the warm pool). An
// operation without `prefix` (an edge from before it was stored) gets the
// name derived from `organizationId`, which is what such computers were
// created with.

export type CloudResourceKind = "vm" | "nic" | "dataDisk" | "osDisk";

/** What the lifecycle reads of an ARM resource. */
export interface CloudResource {
  provisioningState: string | null;
  /** The `organization` tag: a resource under our name tagged for another organization is not ours. */
  organization: string | null;
  vmSize?: string | null;
  diskSizeGB?: number | null;
  /** VM instance view: why provisioning failed, when it did. */
  failure?: string | null;
}

/** Which computer an operation is about. */
export interface CloudTarget {
  organizationId: string;
  /** Resource name prefix, e.g. `oc-org-01hxyz`. */
  prefix: string;
}

type Targeted = { organizationId: string; prefix?: string };

export type CloudOperation =
  | { op: "check" }
  | ({ op: "get"; kind: CloudResourceKind; instanceView?: boolean } & Targeted)
  | ({ op: "putDataDisk"; diskGiB: number; zone: string } & Targeted)
  | ({ op: "putNic" } & Targeted)
  | ({
      op: "putVm";
      size: string;
      zone: string;
      mode: "create" | "attach";
      sshPublicKey: string;
      gatewayUrl?: string;
      hostToken?: string;
    } & Targeted)
  | ({ op: "resizeVm"; size: string } & Targeted)
  | ({ op: "growDataDisk"; diskGiB: number } & Targeted)
  | ({ op: "tagOsDisk" } & Targeted)
  /**
   * A warm pool computer was claimed: move its VM's, NIC's and disks'
   * `organization` tag from `pool` to `organizationId`. Refused (409
   * `not_claimable`) when any of them is tagged for another organization.
   */
  | ({ op: "claimTags" } & Targeted)
  | ({ op: "delete"; kind: CloudResourceKind } & Targeted);

export type CloudReply =
  | { ok: true; resource?: CloudResource | null; deleted?: boolean; missing?: string[]; moved?: number }
  | { ok: false; error: { status: number; code: string; message: string } };

export const CLOUD_ROUTE = "/v1/computers/arm";
