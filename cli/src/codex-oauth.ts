import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { platform } from "node:os";

// Local personal-Codex-subscription OAuth (work 011). The CLI performs the
// OAuth exchange on the user's machine against the authorized Codex endpoints,
// then relays the resulting credential to OpenComputer as a connected
// subscription. Nothing sensitive is ever shown or written to the repo.

// Observed Codex/OpenAI endpoints (see work 011 "Provider authorization").
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE = "openid profile email offline_access";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";

export interface RelayedCodexCredential {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_at: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in: number;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function codexLogin(): Promise<{
  credential: RelayedCodexCredential;
  accountHint: string;
}> {
  const codeVerifier = base64url(randomBytes(32));
  const challengeBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  const codeChallenge = base64url(new Uint8Array(challengeBytes));
  const state = base64url(randomBytes(24));
  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("prompt", "consent");
  authorizeUrl.searchParams.set("scope", SCOPE);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("id_token_add_organizations", "true");
  authorizeUrl.searchParams.set("codex_cli_simplified_flow", "true");
  authorizeUrl.searchParams.set("originator", "opencode");

  const authCode = await exchangeCodeOnCallback(
    authorizeUrl.toString(),
    state,
    CALLBACK_PORT,
  );

  const token = await exchangeToken({
    tokenUrl: TOKEN_URL,
    clientId: CLIENT_ID,
    code: authCode,
    codeVerifier,
    redirectUri,
  });

  return {
    credential: {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_type: token.token_type ?? "Bearer",
      expires_at: Date.now() + token.expires_in * 1_000,
    },
    accountHint: token.access_token.slice(0, 8),
  };
}

// Starts a temporary localhost callback server, opens the browser to the
// authorize URL, and resolves the one-time authorization code.
export function exchangeCodeOnCallback(
  authorizeUrl: string,
  expectedState: string,
  port: number,
  launchBrowser: (url: string) => void = openBrowser,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      if (settled) {
        res.writeHead(409, { connection: "close" }).end();
        return;
      }
      settled = true;
      const finish = (
        status: number,
        message: string,
        result: { code: string } | { error: Error },
      ): void => {
        res.writeHead(status, {
          "content-type": "text/plain",
          connection: "close",
        });
        res.end(message, () => {
          server.close((closeError) => {
            if (closeError) reject(closeError);
            else if ("code" in result) resolve(result.code);
            else reject(result.error);
          });
          server.closeAllConnections();
        });
      };
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!state || !secureEqual(state, expectedState)) {
        finish(
          401,
          "OAuth state mismatch. Please close this window and retry.",
          { error: new Error("OAuth state mismatch") },
        );
        return;
      }
      if (!code) {
        const error = url.searchParams.get("error") ?? "missing code";
        finish(400, `Authorization failed: ${error}`, {
          error: new Error(`Authorization failed: ${error}`),
        });
        return;
      }
      finish(200, "Authorized. You can close this window.", { code });
    });

    server.on("error", (error) => {
      reject(error);
    });

    server.listen(port, "127.0.0.1", () => {
      launchBrowser(authorizeUrl);
    });
  });
}

async function exchangeToken(input: {
  tokenUrl: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: input.redirectUri,
  });
  const response = await fetch(input.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Codex token exchange failed (${String(response.status)})`);
  }
  const token = value as TokenResponse;
  if (typeof token?.access_token !== "string" || typeof token.expires_in !== "number") {
    throw new Error("Codex returned an invalid token response");
  }
  return token;
}

export function openBrowser(url: string): void {
  const command =
    platform() === "darwin"
      ? ["open", url]
      : platform() === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url];
  const child = spawn(command[0]!, command.slice(1), {
    detached: true,
    stdio: "ignore",
  });
  child.once("error", () => undefined);
  child.unref();
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
