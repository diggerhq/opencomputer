import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_API_URL = "https://app.opencomputer.dev";

export interface LoginMetadata {
  credentialId: string;
  keyPrefix: string;
  name: string;
}

export interface StoredConfig {
  apiUrl?: string;
  apiKey?: string;
  login?: LoginMetadata;
}

export interface ResolvedConfig {
  apiUrl: string;
  apiKey?: string;
}

export function configPath(): string {
  return (
    process.env.OPENCOMPUTER_CONFIG ??
    join(homedir(), ".opencomputer", "config.json")
  );
}

export async function loadStoredConfig(): Promise<StoredConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as StoredConfig;
  } catch {
    return {};
  }
}

export async function resolveConfig(overrides: {
  apiUrl?: string;
  apiKey?: string;
}): Promise<ResolvedConfig> {
  const stored = await loadStoredConfig();
  const apiUrl = normalizeAPIURL(
    overrides.apiUrl ??
      process.env.OPENCOMPUTER_API_URL ??
      DEFAULT_API_URL,
  );
  const storedAPIURL = stored.apiUrl
    ? normalizeAPIURL(stored.apiUrl)
    : DEFAULT_API_URL;
  return {
    apiUrl,
    apiKey:
      overrides.apiKey ??
      process.env.OPENCOMPUTER_API_KEY ??
      (storedAPIURL === apiUrl ? stored.apiKey : undefined),
  };
}

export function normalizeAPIURL(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
    )
  ) {
    throw new Error("The OpenComputer API URL must use HTTPS");
  }
  url.pathname = url.pathname.replace(/\/api\/?$/, "").replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export async function saveStoredConfig(config: StoredConfig): Promise<void> {
  const path = configPath();
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(
    directory,
    `.config-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
