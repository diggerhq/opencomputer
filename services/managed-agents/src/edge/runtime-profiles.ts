import type { AgentDeployment } from "../protocol.js";
import type { RuntimeLaunchEnv } from "./runtime-launch.js";

export interface ManagedRuntimeProfileEnv extends RuntimeLaunchEnv {
  MANAGED_RUNTIME_PROFILES?: string;
  MANAGED_RUNTIME_PROFILE_ASSIGNMENTS?: string;
}

export function configuredManagedRuntimeProfileAssignment(
  env: ManagedRuntimeProfileEnv,
  accountId: string,
): string | null {
  if (!env.MANAGED_RUNTIME_PROFILE_ASSIGNMENTS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.MANAGED_RUNTIME_PROFILE_ASSIGNMENTS);
  } catch {
    throw new Error("Managed runtime profile assignments are invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Managed runtime profile assignments must be an object");
  }
  const profileId = (parsed as Record<string, unknown>)[accountId];
  if (profileId === undefined) return null;
  if (typeof profileId !== "string" || !PROFILE_ID.test(profileId)) {
    throw new Error(`Managed runtime profile assignment for ${accountId} is invalid`);
  }
  return profileId;
}

export interface ManagedRuntimeProfile {
  id: string;
  displayName: string;
  imageArn: string;
  imageVersion: string;
  /** The profile's published Modal image; without it the profile has nowhere to run. */
  modalImage?: string;
  /** The supervisor's port in the profile's images (the standard image: 8080). */
  supervisorPort?: number;
}

export type RuntimeDeployment = AgentDeployment & {
  /** Internal placement marker; never persisted as deployment configuration. */
  managedRuntimeProfileId?: string;
  /** The profile's Modal image and supervisor port, carried to the platform's ensure. */
  managedRuntimeModalImage?: string;
  managedRuntimeSupervisorPort?: number;
};

const MODAL_IMAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const PROFILE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Parse the operator-owned profile registry. Invalid configuration fails closed. */
export function managedRuntimeProfiles(
  env: ManagedRuntimeProfileEnv,
): ReadonlyMap<string, ManagedRuntimeProfile> {
  if (!env.MANAGED_RUNTIME_PROFILES) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.MANAGED_RUNTIME_PROFILES);
  } catch {
    throw new Error("Managed runtime profile registry is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Managed runtime profile registry must be an object");
  }
  const profiles = new Map<string, ManagedRuntimeProfile>();
  for (const [id, raw] of Object.entries(parsed)) {
    if (!PROFILE_ID.test(id) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`Managed runtime profile ${id} is invalid`);
    }
    const profile = raw as Record<string, unknown>;
    if (
      !nonEmptyString(profile.displayName) ||
      profile.displayName.length > 100 ||
      !nonEmptyString(profile.imageArn) ||
      !nonEmptyString(profile.imageVersion) ||
      (profile.modalImage !== undefined &&
        (typeof profile.modalImage !== "string" ||
          !MODAL_IMAGE_NAME.test(profile.modalImage))) ||
      (profile.supervisorPort !== undefined &&
        (typeof profile.supervisorPort !== "number" ||
          !Number.isInteger(profile.supervisorPort) ||
          profile.supervisorPort < 1 ||
          profile.supervisorPort > 65_535))
    ) {
      throw new Error(`Managed runtime profile ${id} is invalid`);
    }
    profiles.set(id, {
      id,
      displayName: profile.displayName,
      imageArn: profile.imageArn,
      imageVersion: profile.imageVersion,
      ...(profile.modalImage !== undefined
        ? { modalImage: profile.modalImage as string }
        : {}),
      ...(profile.supervisorPort !== undefined
        ? { supervisorPort: profile.supervisorPort as number }
        : {}),
    });
  }
  return profiles;
}

export function managedRuntimeProfile(
  env: ManagedRuntimeProfileEnv,
  profileId: string | null,
): ManagedRuntimeProfile | null {
  if (!profileId) return null;
  const profile = managedRuntimeProfiles(env).get(profileId);
  if (!profile) {
    throw new Error(`Managed runtime profile ${profileId} is not configured`);
  }
  return profile;
}

/** Apply a customer profile after the platform default, so it always wins. */
export function runtimeDeploymentForProfile(
  env: ManagedRuntimeProfileEnv,
  deployment: AgentDeployment,
  profile: ManagedRuntimeProfile | null,
): RuntimeDeployment {
  return {
    ...deployment,
    imageArn:
      profile?.imageArn ?? env.BLUE_RUNTIME_IMAGE_ARN ?? deployment.imageArn,
    imageVersion:
      profile?.imageVersion ??
      env.BLUE_RUNTIME_IMAGE_VERSION ??
      deployment.imageVersion,
    ...(profile ? { managedRuntimeProfileId: profile.id } : {}),
    ...(profile?.modalImage
      ? {
          managedRuntimeModalImage: profile.modalImage,
          managedRuntimeSupervisorPort: profile.supervisorPort ?? 8080,
        }
      : {}),
  };
}
