/**
 * Per-account rollout gate shared by the Modal tool sandbox
 * (platform/modal-sandbox.ts) and the session runtime (edge/runtime-launch.ts):
 * an account is selected when it is named in the allowlist ('*' selects
 * everyone) or when its stable bucket falls inside the rollout percent.
 */
export function allowlistEntries(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function rolloutPercent(value: string | undefined): number {
  const percent = Number(value ?? "0");
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(percent, 100);
}

/** Stable 0-99 bucket for an account id (djb2-xor); no crypto needed. */
export function rolloutBucket(accountId: string): number {
  let hash = 5381;
  for (let i = 0; i < accountId.length; i += 1) {
    hash = (hash * 33) ^ accountId.charCodeAt(i);
  }
  return (hash >>> 0) % 100;
}

export function accountSelected(
  accountId: string,
  allowlist: string | undefined,
  percent: string | undefined,
): boolean {
  const entries = allowlistEntries(allowlist);
  if (entries.includes("*") || entries.includes(accountId)) return true;
  return rolloutBucket(accountId) < rolloutPercent(percent);
}
