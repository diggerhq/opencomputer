import type { SessionLabels } from "../protocol.js";

/**
 * Session labels: application metadata an owner attaches to a session so a
 * list can be filtered by it. The bounds are the public contract; both the
 * edge (to answer `400 invalid_labels`) and the Session object (so no other
 * caller can store more) validate with the same functions.
 */
export const SESSION_LABEL_LIMITS = {
  maxKeys: 16,
  keyPattern: /^[a-z][a-z0-9_.-]{0,63}$/,
  maxValueLength: 256,
  maxTotalBytes: 4 * 1024,
} as const;

export type LabelPatch = { set: SessionLabels; unset: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function labelKeyError(key: string): string | null {
  return SESSION_LABEL_LIMITS.keyPattern.test(key)
    ? null
    : `Label key ${JSON.stringify(key)} must match ${SESSION_LABEL_LIMITS.keyPattern.source}`;
}

function labelValueError(key: string, value: unknown): string | null {
  if (typeof value !== "string") {
    return `Label ${JSON.stringify(key)} must be a string`;
  }
  if (value.length > SESSION_LABEL_LIMITS.maxValueLength) {
    return `Label ${JSON.stringify(key)} exceeds ${SESSION_LABEL_LIMITS.maxValueLength} characters`;
  }
  return null;
}

/** The bytes a label map costs, as its canonical JSON serialization. */
export function labelBytes(labels: SessionLabels): number {
  return new TextEncoder().encode(JSON.stringify(sortLabels(labels))).length;
}

function sortLabels(labels: SessionLabels): SessionLabels {
  return Object.fromEntries(
    Object.keys(labels)
      .sort()
      .map((key) => [key, labels[key]!]),
  );
}

function boundsError(labels: SessionLabels): string | null {
  const keys = Object.keys(labels);
  if (keys.length > SESSION_LABEL_LIMITS.maxKeys) {
    return `At most ${SESSION_LABEL_LIMITS.maxKeys} labels are allowed`;
  }
  if (labelBytes(labels) > SESSION_LABEL_LIMITS.maxTotalBytes) {
    return `Labels exceed ${SESSION_LABEL_LIMITS.maxTotalBytes} bytes in total`;
  }
  return null;
}

/**
 * A complete label map as a client sends it on create. `undefined` is an
 * empty map; anything that is not an object of bounded string values is an
 * error the caller reports as `invalid_labels`.
 */
export function parseLabels(
  value: unknown,
): { labels: SessionLabels } | { error: string } {
  if (value === undefined) return { labels: {} };
  if (!isRecord(value)) return { error: "labels must be an object of strings" };
  const labels: SessionLabels = {};
  for (const [key, entry] of Object.entries(value)) {
    const keyError = labelKeyError(key);
    if (keyError) return { error: keyError };
    const valueError = labelValueError(key, entry);
    if (valueError) return { error: valueError };
    labels[key] = entry as string;
  }
  const bounds = boundsError(labels);
  return bounds ? { error: bounds } : { labels: sortLabels(labels) };
}

/** The body of `PATCH /sessions/<id>/labels`: `{ set?, unset? }`, both bounded. */
export function parseLabelPatch(
  value: unknown,
): LabelPatch | { error: string } {
  if (!isRecord(value)) return { error: "Expected { set?, unset? }" };
  const unknownKeys = Object.keys(value).filter(
    (key) => key !== "set" && key !== "unset",
  );
  if (unknownKeys.length) {
    return { error: `Unknown field ${JSON.stringify(unknownKeys[0])}` };
  }
  if (value.set === undefined && value.unset === undefined) {
    return { error: "Expected set and/or unset" };
  }
  const set = parseLabels(value.set);
  if ("error" in set) return set;
  const unset: string[] = [];
  if (value.unset !== undefined) {
    if (
      !Array.isArray(value.unset) ||
      value.unset.some((key) => typeof key !== "string")
    ) {
      return { error: "unset must be an array of label keys" };
    }
    if (value.unset.length > SESSION_LABEL_LIMITS.maxKeys) {
      return { error: `At most ${SESSION_LABEL_LIMITS.maxKeys} keys can be unset at once` };
    }
    for (const key of value.unset as string[]) {
      const keyError = labelKeyError(key);
      if (keyError) return { error: keyError };
      unset.push(key);
    }
  }
  return { set: set.labels, unset };
}

/**
 * Per-key last-write-wins: `unset` removes, then `set` writes. The result
 * must itself satisfy the bounds, so a patch that would grow a session past
 * them is refused whole.
 */
export function applyLabelPatch(
  current: SessionLabels,
  patch: LabelPatch,
): { labels: SessionLabels } | { error: string } {
  const next: SessionLabels = { ...current };
  for (const key of patch.unset) delete next[key];
  for (const [key, value] of Object.entries(patch.set)) next[key] = value;
  const bounds = boundsError(next);
  return bounds ? { error: bounds } : { labels: sortLabels(next) };
}

/** Stored label JSON back to a map; anything unreadable is an empty map. */
export function readLabels(json: string | null | undefined): SessionLabels {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) return {};
    const labels: SessionLabels = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") labels[key] = value;
    }
    return labels;
  } catch {
    return {};
  }
}

/** A label selector names at most this many pairs (event subscriptions' `sourceLabels`). */
export const LABEL_SELECTOR_MAX_KEYS = 8;

/**
 * A label selector as a client sends it: the same key and value rules as
 * session labels, between one and LABEL_SELECTOR_MAX_KEYS pairs. An empty
 * selector is refused rather than read as "every session", so a caller that
 * meant to narrow never widens by accident.
 */
export function parseLabelSelector(
  value: unknown,
): { labels: SessionLabels } | { error: string } {
  if (!isRecord(value)) return { error: "expected an object of strings" };
  const keys = Object.keys(value).length;
  if (keys === 0) return { error: "at least one label is required" };
  if (keys > LABEL_SELECTOR_MAX_KEYS) {
    return { error: `at most ${LABEL_SELECTOR_MAX_KEYS} labels are allowed` };
  }
  return parseLabels(value);
}

/** Whether `labels` carries every pair of `selector`, value for value. */
export function labelsMatch(labels: SessionLabels, selector: SessionLabels): boolean {
  return Object.entries(selector).every(
    ([key, value]) => Object.hasOwn(labels, key) && labels[key] === value,
  );
}
