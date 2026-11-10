// The shape of a preview registration and the claim rule (work 074). Pure,
// shared by the PreviewDurableObject, the previews Worker and the computer
// object that registers names.

import { validPreviewName } from "./names.js";

/** What one name points at. */
export interface PreviewRecord {
  name: string;
  organizationId: string;
  /** The computer's Cloudflare Tunnel; its hostname is `<tunnelId>.t.opencomputer.app`. */
  tunnelId: string;
  port: number;
  /** The session that registered it, for the dashboard; never shown publicly. */
  createdBy: string;
  createdAt: number;
  lastHitAt: number;
}

export interface PreviewClaim {
  organizationId: string;
  tunnelId: string;
  port: number;
  createdBy: string;
}

export type PreviewClaimResult =
  | { ok: true; record: PreviewRecord }
  | { ok: false; error: "name_taken" | "denied" | "invalid" };

export type PreviewResolution =
  | { state: "live"; record: PreviewRecord }
  | { state: "denied" }
  | { state: "free" };

/** Served responses write `lastHitAt` at most this often per name. */
export const HIT_WRITE_INTERVAL_MS = 30_000;

/** Ports a preview may point at: unprivileged, and not the host proxy's own. */
export function validPreviewPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 7070;
}

export function claimOutcome(
  name: string,
  current: PreviewRecord | null,
  denied: boolean,
  claim: PreviewClaim,
  now: number,
): PreviewClaimResult {
  if (denied) return { ok: false, error: "denied" };
  if (!validPreviewName(name) || !validPreviewPort(claim.port) || !/^[a-z0-9-]{1,64}$/.test(claim.tunnelId)) {
    return { ok: false, error: "invalid" };
  }
  if (current && current.organizationId !== claim.organizationId) return { ok: false, error: "name_taken" };
  return {
    ok: true,
    record: {
      name,
      organizationId: claim.organizationId,
      tunnelId: claim.tunnelId,
      port: claim.port,
      createdBy: claim.createdBy,
      createdAt: current?.createdAt ?? now,
      lastHitAt: current?.lastHitAt ?? now,
    },
  };
}
