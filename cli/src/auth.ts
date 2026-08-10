import { spawn } from "node:child_process";
import { hostname, platform } from "node:os";
import { OpenComputerClient, type OpenComputerIdentity } from "./api.js";
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

export async function login(
  config: ResolvedConfig,
  options: { noBrowser: boolean; force: boolean },
): Promise<OpenComputerIdentity> {
  if (process.env.OPENCOMPUTER_API_KEY && !options.force) {
    throw new Error(
      "OPENCOMPUTER_API_KEY currently controls authentication; unset it or use --force.",
    );
  }
  const stored = await loadStoredConfig();
  const storedAPIURL = stored.apiUrl ?? config.apiUrl;
  if (
    stored.apiKey &&
    !options.force &&
    storedAPIURL.replace(/\/$/, "") === config.apiUrl.replace(/\/$/, "")
  ) {
    try {
      return await new OpenComputerClient({
        apiUrl: config.apiUrl,
        apiKey: stored.apiKey,
      }).whoami();
    } catch {
      // An expired saved login is replaced below.
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
  let credential:
    | {
        id: string;
        key: string;
        key_prefix: string;
        name: string;
      }
    | undefined;
  while (Date.now() + interval * 1_000 < deadline) {
    await sleep(interval * 1_000);
    const exchange = await client.exchangeLogin(
      receipt.device_code,
      credentialName(),
    );
    if (exchange.status === "authorized") {
      credential = exchange.credential;
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
    options.force && stored.apiKey
      ? { apiKey: stored.apiKey, apiUrl: stored.apiUrl ?? config.apiUrl }
      : null;
  await saveStoredConfig({
    apiUrl: config.apiUrl,
    apiKey: credential.key,
    login: {
      credentialId: credential.id,
      keyPrefix: credential.key_prefix,
      name: credential.name,
    },
  });
  if (previous) {
    await new OpenComputerClient(previous).revokeCredential().catch(() => {
      process.stderr.write(
        "Warning: the previous CLI credential could not be revoked. Remove it in the dashboard.\n",
      );
    });
  }
  return identity;
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
