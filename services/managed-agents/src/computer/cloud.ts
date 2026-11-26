// The edge's view of the cloud: what the lifecycle asks of it, and the
// implementation that forwards each operation to the platform Worker over
// its service binding (cloud-contract.ts). Tests give the lifecycle a fake.

import {
  CLOUD_ROUTE,
  type CloudOperation,
  type CloudReply,
  type CloudResource,
  type CloudResourceKind,
  type CloudTarget,
} from "./cloud-contract.js";

/** A cloud call failed. 503 `not_configured` and 4xx refusals are not worth retrying. */
export class CloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CloudError";
  }

  get retryable(): boolean {
    if (this.code === "not_configured" || this.code === "invalid_request" || this.code === "not_claimable") return false;
    return this.status === 0 || this.status === 409 || this.status === 429 || this.status >= 500;
  }
}

export interface ComputerCloud {
  /** Settings the platform still lacks, by name. */
  missing(): Promise<string[]>;
  get(target: CloudTarget, kind: CloudResourceKind, options?: { instanceView?: boolean }): Promise<CloudResource | null>;
  putDataDisk(target: CloudTarget, spec: { diskGiB: number; zone: string }): Promise<CloudResource>;
  putNic(target: CloudTarget): Promise<CloudResource>;
  putVm(
    target: CloudTarget,
    spec: {
      size: string;
      zone: string;
      mode: "create" | "attach";
      sshPublicKey: string;
      gatewayUrl?: string;
      hostToken?: string;
    },
  ): Promise<CloudResource>;
  resizeVm(target: CloudTarget, size: string): Promise<CloudResource>;
  growDataDisk(target: CloudTarget, diskGiB: number): Promise<CloudResource>;
  tagOsDisk(target: CloudTarget): Promise<void>;
  /** A claimed pool computer: its resources' `organization` tag moves from `pool` to the target's organization. */
  claimTags(target: CloudTarget): Promise<void>;
  /** Starts deleting; false when it was already gone. */
  delete(target: CloudTarget, kind: CloudResourceKind): Promise<boolean>;
}

export class PlatformComputerCloud implements ComputerCloud {
  constructor(private readonly platform: Fetcher) {}

  private async call(operation: CloudOperation): Promise<Extract<CloudReply, { ok: true }>> {
    let response: Response;
    try {
      response = await this.platform.fetch(`https://blue-platform${CLOUD_ROUTE}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(operation),
      });
    } catch (error) {
      throw new CloudError(0, "platform_unreachable", `platform unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = (await response.json().catch(() => null)) as CloudReply | null;
    if (body?.ok) return body;
    if (body && !body.ok) throw new CloudError(body.error.status, body.error.code, body.error.message);
    throw new CloudError(response.status, `Http${response.status}`, `platform answered ${response.status}`);
  }

  async missing(): Promise<string[]> {
    return (await this.call({ op: "check" })).missing ?? [];
  }

  async get(target: CloudTarget, kind: CloudResourceKind, options: { instanceView?: boolean } = {}) {
    return (await this.call({ op: "get", ...target, kind, ...options })).resource ?? null;
  }

  async putDataDisk(target: CloudTarget, spec: { diskGiB: number; zone: string }) {
    return required(await this.call({ op: "putDataDisk", ...target, ...spec }));
  }

  async putNic(target: CloudTarget) {
    return required(await this.call({ op: "putNic", ...target }));
  }

  async putVm(target: CloudTarget, spec: Parameters<ComputerCloud["putVm"]>[1]) {
    return required(await this.call({ op: "putVm", ...target, ...spec }));
  }

  async resizeVm(target: CloudTarget, size: string) {
    return required(await this.call({ op: "resizeVm", ...target, size }));
  }

  async growDataDisk(target: CloudTarget, diskGiB: number) {
    return required(await this.call({ op: "growDataDisk", ...target, diskGiB }));
  }

  async tagOsDisk(target: CloudTarget) {
    await this.call({ op: "tagOsDisk", ...target });
  }

  async claimTags(target: CloudTarget) {
    await this.call({ op: "claimTags", ...target });
  }

  async delete(target: CloudTarget, kind: CloudResourceKind) {
    return (await this.call({ op: "delete", ...target, kind })).deleted ?? false;
  }
}

function required(reply: { resource?: CloudResource | null }): CloudResource {
  return reply.resource ?? { provisioningState: null, organization: null };
}
