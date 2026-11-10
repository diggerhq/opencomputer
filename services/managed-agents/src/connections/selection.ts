import type { Connection } from "../protocol.js";

export type ManagedGoogleConnectionSelection =
  | {
      kind: "selected";
      connection: Connection & { externalAccountId: string };
    }
  | { kind: "not_found" }
  | { kind: "alias_required"; labels: string[] };

export type ManagedProviderConnectionSelection = ManagedGoogleConnectionSelection;

export function requestedConnectionLabel(
  value: unknown,
): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const label = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,39}$/.test(label) ? label : null;
}

export function connectionService(value: string): string {
  const service = value.trim().toLowerCase();
  const aliases: Record<string, string> = {
    google: "gmail",
    googlecalendar: "calendar",
    googledrive: "drive",
    googlesheets: "sheets",
  };
  return aliases[service] ?? service;
}

export function googleServiceForScopes(scopes: string[]): string | null {
  if (scopes.some((scope) => scope.includes("/auth/gmail."))) return "gmail";
  if (scopes.some((scope) => scope.includes("/auth/calendar"))) {
    return "calendar";
  }
  if (scopes.some((scope) => scope.includes("/auth/drive"))) return "drive";
  if (scopes.some((scope) => scope.includes("/auth/spreadsheets"))) {
    return "sheets";
  }
  return null;
}

export function selectManagedGoogleConnection(
  connections: Connection[],
  service: string,
  label?: string,
): ManagedGoogleConnectionSelection {
  const candidates = connections.filter(
    (
      connection,
    ): connection is Connection & { externalAccountId: string } =>
      connection.kind === "tool" &&
      connection.provider === "google" &&
      connection.status === "connected" &&
      typeof connection.externalAccountId === "string" &&
      connection.externalAccountId.length > 0 &&
      googleServiceForScopes(connection.scopes) === service,
  );

  if (label !== undefined) {
    const connection = candidates.find(
      (candidate) => candidate.label === label,
    );
    return connection
      ? { kind: "selected", connection }
      : { kind: "not_found" };
  }

  const [connection] = candidates;
  if (!connection) return { kind: "not_found" };
  if (candidates.length === 1) return { kind: "selected", connection };
  return {
    kind: "alias_required",
    labels: candidates.map((connection) => connection.label).sort(),
  };
}

export function selectManagedProviderConnection(
  connections: Connection[],
  provider: string,
  label?: string,
): ManagedProviderConnectionSelection {
  const candidates = connections.filter(
    (
      connection,
    ): connection is Connection & { externalAccountId: string } =>
      connection.kind === "tool" &&
      connection.provider === provider &&
      connection.status === "connected" &&
      typeof connection.externalAccountId === "string" &&
      connection.externalAccountId.length > 0,
  );
  if (label !== undefined) {
    const connection = candidates.find(
      (candidate) => candidate.label === label,
    );
    return connection
      ? { kind: "selected", connection }
      : { kind: "not_found" };
  }
  const [connection] = candidates;
  if (!connection) return { kind: "not_found" };
  if (candidates.length === 1) return { kind: "selected", connection };
  return {
    kind: "alias_required",
    labels: candidates.map((candidate) => candidate.label).sort(),
  };
}
