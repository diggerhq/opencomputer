import { spawn } from "node:child_process";
import { hostname, platform } from "node:os";
import {
  APIError,
  OpenComputerClient,
  type LoginCredential,
  type OpenComputerIdentity,
  type OpenComputerOrg,
} from "./api.js";
import {
  loadStoredConfig,
  saveStoredConfig,
  type ResolvedConfig,
} from "./config.js";

function credentialName(): string {
  const cleanHost = hostname()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return `opencomputer CLI${cleanHost ? ` on ${cleanHost}` : ""}`.slice(0, 100);
}

export function openBrowser(url: string): boolean {
  const command =
    platform() === "darwin"
      ? ["open", url]
      : platform() === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  try {
    const child = spawn(command[0]!, command.slice(1), {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export type LoginIdentity = OpenComputerIdentity & { orgs?: OpenComputerOrg[] };

function sameAPIURL(a: string, b: string): boolean {
  return a.replace(/\/$/, "") === b.replace(/\/$/, "");
}

/** A saved login the edge refuses to move: expired, or minted before org switching. */
function loginCannotSwitch(error: unknown): boolean {
  return (
    error instanceof APIError &&
    (error.status === 401 ||
      (error.status === 403 && error.message === "cli_login_required"))
  );
}

function orgMatches(org: OpenComputerOrg | undefined, wanted: string): boolean {
  return (
    !!org && (org.id === wanted || org.name.toLowerCase() === wanted.toLowerCase())
  );
}

function formatOrgs(orgs: OpenComputerOrg[]): string {
  return orgs.map((org) => `  ${org.name}  (${org.id})`).join("\n");
}

async function saveLogin(apiUrl: string, credential: LoginCredential): Promise<void> {
  await saveStoredConfig({
    apiUrl,
    apiKey: credential.key,
    login: {
      credentialId: credential.id,
      keyPrefix: credential.key_prefix,
      name: credential.name,
    },
  });
}

async function switchSavedLogin(
  apiUrl: string,
  apiKey: string,
  org: string,
): Promise<LoginIdentity> {
  const client = new OpenComputerClient({ apiUrl, apiKey });
  let result;
  try {
    result = await client.switchLoginOrg(org);
  } catch (error) {
    if (error instanceof APIError && (error.status === 404 || error.status === 409)) {
      const { orgs } = await client.loginOrgs();
      throw new Error(
        (error.status === 404
          ? `You are not a member of an organization named or with id "${org}".`
          : `More than one of your organizations is named "${org}"; use its id.`) +
          `\nYour organizations:\n${formatOrgs(orgs)}`,
      );
    }
    throw error;
  }
  let key = apiKey;
  if (result.status === "switched" && result.credential) {
    key = result.credential.key;
    await saveLogin(apiUrl, result.credential);
    if (result.previous_credential_revoked === false) {
      process.stderr.write(
        "Warning: the previous CLI credential could not be revoked. Remove it in the dashboard.\n",
      );
    }
  }
  const identity = await new OpenComputerClient({ apiUrl, apiKey: key }).whoami();
  return { ...identity, orgs: result.orgs };
}

/**
 * Moves the saved CLI login to another of the user's orgs without a browser
 * round trip: the edge trades the login credential for one in `org`.
 */
export async function switchOrg(
  config: ResolvedConfig,
  org: string,
): Promise<LoginIdentity> {
  if (process.env.OPENCOMPUTER_API_KEY) {
    throw new Error(
      "OPENCOMPUTER_API_KEY currently controls authentication; unset it to switch the CLI login's organization.",
    );
  }
  const stored = await loadStoredConfig();
  if (!stored.apiKey || !stored.login) {
    throw new Error("Not logged in. Run `opencomputer login --org <id|name>`.");
  }
  try {
    return await switchSavedLogin(stored.apiUrl ?? config.apiUrl, stored.apiKey, org);
  } catch (error) {
    if (loginCannotSwitch(error)) {
      throw new Error(
        `This login cannot switch organizations (it has expired or predates org switching). Run \`opencomputer login --force --org ${JSON.stringify(org)}\`.`,
      );
    }
    throw error;
  }
}

/** The orgs the saved CLI login can switch between, and the one it is bound to. */
export async function listOrgs(
  config: ResolvedConfig,
): Promise<{ org_id: string; orgs: OpenComputerOrg[] }> {
  const stored = await loadStoredConfig();
  if (process.env.OPENCOMPUTER_API_KEY || !stored.apiKey || !stored.login) {
    throw new Error("`opencomputer org list` needs a login from `opencomputer login`.");
  }
  try {
    return await new OpenComputerClient({
      apiUrl: stored.apiUrl ?? config.apiUrl,
      apiKey: stored.apiKey,
    }).loginOrgs();
  } catch (error) {
    if (loginCannotSwitch(error)) {
      throw new Error(
        "This login cannot list organizations (it has expired or predates org switching). Run `opencomputer login --force`.",
      );
    }
    throw error;
  }
}

export async function login(
  config: ResolvedConfig,
  options: { noBrowser: boolean; force: boolean; org?: string },
): Promise<LoginIdentity> {
  if (process.env.OPENCOMPUTER_API_KEY && !options.force) {
    throw new Error(
      "OPENCOMPUTER_API_KEY currently controls authentication; unset it or use --force.",
    );
  }
  const stored = await loadStoredConfig();
  const storedAPIURL = stored.apiUrl ?? config.apiUrl;
  if (stored.apiKey && !options.force && sameAPIURL(storedAPIURL, config.apiUrl)) {
    if (options.org && stored.login) {
      try {
        return await switchSavedLogin(config.apiUrl, stored.apiKey, options.org);
      } catch (error) {
        // An expired or pre-switching login is replaced below.
        if (!loginCannotSwitch(error)) throw error;
      }
    } else {
      try {
        return await new OpenComputerClient({
          apiUrl: config.apiUrl,
          apiKey: stored.apiKey,
        }).whoami();
      } catch {
        // An expired saved login is replaced below.
      }
    }
  }

  const client = new OpenComputerClient({
    apiUrl: config.apiUrl,
  });
  const receipt = await client.startLogin();
  if (
    !receipt.device_code ||
    !receipt.user_code ||
    !receipt.verification_uri_complete ||
    receipt.expires_in <= 0 ||
    receipt.interval <= 0
  ) {
    throw new Error("OpenComputer returned an incomplete login response.");
  }
  const verificationURL = new URL(receipt.verification_uri_complete);
  if (verificationURL.protocol !== "https:") {
    throw new Error("OpenComputer returned an unsafe login URL.");
  }

  process.stderr.write(
    `\nConfirm this code in your browser:\n\n  ${receipt.user_code}\n\n` +
      `  ${receipt.verification_uri_complete}\n`,
  );
  if (!options.noBrowser && !openBrowser(receipt.verification_uri_complete)) {
    process.stderr.write("\nCould not open a browser automatically.\n");
  }
  process.stderr.write("\nWaiting for confirmation…\n");

  const deadline = Date.now() + receipt.expires_in * 1_000;
  let interval = receipt.interval;
  let credential: LoginCredential | undefined;
  let boundOrg: OpenComputerOrg | undefined;
  let orgs: OpenComputerOrg[] | undefined;
  while (Date.now() + interval * 1_000 < deadline) {
    await sleep(interval * 1_000);
    const exchange = await client.exchangeLogin(
      receipt.device_code,
      credentialName(),
    );
    if (exchange.status === "authorized") {
      credential = exchange.credential;
      boundOrg = exchange.org;
      orgs = exchange.orgs;
      break;
    }
    interval = Math.max(interval, exchange.retry_after ?? interval);
  }
  if (!credential?.key || !credential.id) {
    throw new Error(
      "Login confirmation expired. Run `opencomputer login` again.",
    );
  }

  const authenticated = new OpenComputerClient({
    apiUrl: config.apiUrl,
    apiKey: credential.key,
  });
  const identity = await authenticated.whoami();
  const previous =
    stored.apiKey && stored.apiKey !== credential.key && (options.force || options.org)
      ? { apiKey: stored.apiKey, apiUrl: stored.apiUrl ?? config.apiUrl }
      : null;
  await saveLogin(config.apiUrl, credential);
  if (previous) {
    await new OpenComputerClient(previous).revokeCredential().catch(() => {
      process.stderr.write(
        "Warning: the previous CLI credential could not be revoked. Remove it in the dashboard.\n",
      );
    });
  }
  if (options.org && !orgMatches(boundOrg, options.org)) {
    return switchSavedLogin(config.apiUrl, credential.key, options.org);
  }
  return { ...identity, ...(orgs ? { orgs } : {}) };
}

export async function logout(
  config: ResolvedConfig,
  localOnly: boolean,
): Promise<void> {
  const stored = await loadStoredConfig();
  if (!stored.apiKey || !stored.login) {
    throw new Error("There is no CLI-managed login to revoke.");
  }
  if (!localOnly) {
    await new OpenComputerClient({
      apiUrl: stored.apiUrl ?? config.apiUrl,
      apiKey: stored.apiKey,
    }).revokeCredential();
  }
  await saveStoredConfig({ apiUrl: stored.apiUrl ?? config.apiUrl });
}
