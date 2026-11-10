import { DEPLOYMENT_REGIONS, type DeploymentRegion } from "./protocol.js";

/**
 * Deployment regions (work 057). Each is a Modal sandbox region, used as is,
 * and maps to the nearest Durable Object location hint. A hint is best
 * effort and applies only when an object is first created, so lookups by
 * name need no region.
 */
const LOCATION_HINTS: Record<DeploymentRegion, DurableObjectLocationHint> = {
  us: "enam",
  eu: "weur",
  ap: "apac",
  "us-east": "enam",
  "us-central": "enam",
  "us-south": "enam",
  "us-west": "wnam",
  "eu-west": "weur",
  "eu-north": "eeur",
  "eu-south": "weur",
  "ap-northeast": "apac",
  "ap-southeast": "apac",
  "ap-south": "apac",
  "ap-melbourne": "oc",
  jp: "apac",
  au: "oc",
  uk: "weur",
  ca: "enam",
  me: "me",
  sa: "sam",
  af: "afr",
  mx: "wnam",
};

/** Supported values, for error messages. */
export const SUPPORTED_REGIONS = DEPLOYMENT_REGIONS.join(", ");

/** Header carrying the location hint to the Workerd runtime's session create. */
export const LOCATION_HINT_HEADER = "x-opencomputer-location-hint";

/** The region, undefined when absent, or null when present and unsupported. */
export function parseDeploymentRegion(
  value: unknown,
): DeploymentRegion | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && Object.hasOwn(LOCATION_HINTS, value)
    ? (value as DeploymentRegion)
    : null;
}

export function modalRegion(region: DeploymentRegion | undefined): string | undefined {
  return region;
}

export function durableObjectLocationHint(
  region: DeploymentRegion | undefined,
): DurableObjectLocationHint | undefined {
  return region ? LOCATION_HINTS[region] : undefined;
}

/** `getByName` options placing a new object in the deployment's region. */
export function regionPlacement(
  region: DeploymentRegion | undefined,
): DurableObjectNamespaceGetDurableObjectOptions | undefined {
  const locationHint = durableObjectLocationHint(region);
  return locationHint ? { locationHint } : undefined;
}

/** Headers asking the Workerd runtime to create a session object in the region. */
export function regionHeaders(region: DeploymentRegion | undefined): Record<string, string> {
  const locationHint = durableObjectLocationHint(region);
  return locationHint ? { [LOCATION_HINT_HEADER]: locationHint } : {};
}

/** A location hint read back from `LOCATION_HINT_HEADER`, when it is one. */
export function parseLocationHint(
  value: string | null,
): DurableObjectLocationHint | undefined {
  return Object.values(LOCATION_HINTS).find((hint) => hint === value);
}
