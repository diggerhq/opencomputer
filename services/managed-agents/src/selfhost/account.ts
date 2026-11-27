// The self-hosted gateway's ACCOUNTS binding (spike): the hosted Account object holds GitHub App
// installations, managed model credentials and service connections, none of which a self-hosted
// gateway has. This stand-in answers "none" to what the Computer path asks of it, except the
// organization's model credential, which /setup (setup.ts) stores here with the rest of its
// configuration. The Computer actor reads that credential the way it reads a hosted
// organization's managed key (`resolveManagedModelCredential`), so no Computer code changes.
//
// Secret values are sealed (crypto/seal.ts, BLUE_CHANNEL_ENCRYPTION_KEY) and never returned by
// `status`; only `resolveManagedModelCredential` and `slackApp` unseal, for the actor and for the
// entry's Slack routes.

import { DurableObject } from "cloudflare:workers";
import { seal, unseal } from "../crypto/seal.js";
import type { SetupStatus, SetupWrite } from "./setup.js";

interface Sealed {
  sealed: string;
  at: string;
}

/** What is stored under `setup`: plain fields and sealed secrets. */
interface Stored {
  claude?: Sealed & { kind: "api-key" | "oauth" };
  hostsAcknowledgedAt?: string;
  slack?: { clientId: string; clientSecret?: Sealed; signingSecret?: Sealed };
  oidc?: { issuer: string; clientId: string; clientSecret?: Sealed };
  workos?: { clientId: string; apiKey?: Sealed };
  github?: { appId: string; slug: string; privateKey?: Sealed; webhookSecret?: Sealed };
}

interface AccountEnv {
  BLUE_CHANNEL_ENCRYPTION_KEY?: string;
}

const KEY = "setup";

export class SelfhostAccountDurableObject extends DurableObject<AccountEnv> {
  async listGitHubInstallations(): Promise<[]> {
    return [];
  }
  async getGitHubInstallation(): Promise<null> {
    return null;
  }
  async mintGitHubInstallationToken(): Promise<never> {
    throw new Error("GitHub is not configured on this self-hosted gateway");
  }
  async listComputerServiceAttachments(): Promise<[]> {
    return [];
  }
  async grantableComputerConnections(): Promise<[]> {
    return [];
  }
  async getConnection(): Promise<null> {
    return null;
  }
  async getConnectionForUser(): Promise<null> {
    return null;
  }

  /** The organization's model credential: the Claude credential /setup stored, whatever `provider` the actor names. */
  async resolveManagedModelCredential(_provider?: string): Promise<{ id: string; key: string } | null> {
    const claude = (await this.stored()).claude;
    if (!claude) return null;
    return { id: `selfhost-${claude.kind}`, key: await this.open(claude, "claude") };
  }

  // ------------------------------------------------------------------ /setup (setup.ts)

  async status(): Promise<SetupStatus> {
    const s = await this.stored();
    return {
      claude: s.claude ? { set: true, kind: s.claude.kind, at: s.claude.at } : { set: false },
      hostsAcknowledged: !!s.hostsAcknowledgedAt,
      slack: s.slack ? { clientId: s.slack.clientId, clientSecret: !!s.slack.clientSecret, signingSecret: !!s.slack.signingSecret } : null,
      oidc: s.oidc ? { issuer: s.oidc.issuer, clientId: s.oidc.clientId, clientSecret: !!s.oidc.clientSecret } : null,
      workos: s.workos ? { clientId: s.workos.clientId, apiKey: !!s.workos.apiKey } : null,
      github: s.github ? { appId: s.github.appId, slug: s.github.slug, privateKey: !!s.github.privateKey, webhookSecret: !!s.github.webhookSecret } : null,
    };
  }

  /** One step's values, already checked by setup.ts. An empty or absent secret keeps the stored one. */
  async write(w: SetupWrite): Promise<void> {
    const s = await this.stored();
    const keep = async (old: Sealed | undefined, value: string | undefined, field: string) => (value ? await this.sealAs(value, field) : old);
    switch (w.step) {
      case "claude":
        s.claude = { ...(await this.sealAs(w.token, "claude")), kind: w.kind };
        break;
      case "claude-delete":
        delete s.claude;
        break;
      case "hosts-ack":
        s.hostsAcknowledgedAt = new Date().toISOString();
        break;
      case "slack":
        s.slack = {
          clientId: w.clientId,
          clientSecret: await keep(s.slack?.clientSecret, w.clientSecret, "slack.clientSecret"),
          signingSecret: await keep(s.slack?.signingSecret, w.signingSecret, "slack.signingSecret"),
        };
        break;
      case "oidc":
        s.oidc = { issuer: w.issuer, clientId: w.clientId, clientSecret: await keep(s.oidc?.clientSecret, w.clientSecret, "oidc.clientSecret") };
        break;
      case "workos":
        s.workos = { clientId: w.clientId, apiKey: await keep(s.workos?.apiKey, w.apiKey, "workos.apiKey") };
        break;
      case "github":
        s.github = {
          appId: w.appId,
          slug: w.slug,
          privateKey: await keep(s.github?.privateKey, w.privateKey, "github.privateKey"),
          webhookSecret: await keep(s.github?.webhookSecret, w.webhookSecret, "github.webhookSecret"),
        };
        break;
    }
    await this.ctx.storage.put(KEY, s);
  }

  /** The Slack app's credentials for the entry's Slack routes (SLACK_COMPUTER_*); null until all three are set. */
  async slackApp(): Promise<{ clientId: string; clientSecret: string; signingSecret: string } | null> {
    const slack = (await this.stored()).slack;
    if (!slack?.clientSecret || !slack.signingSecret) return null;
    return {
      clientId: slack.clientId,
      clientSecret: await this.open(slack.clientSecret, "slack.clientSecret"),
      signingSecret: await this.open(slack.signingSecret, "slack.signingSecret"),
    };
  }

  private async stored(): Promise<Stored> {
    return (await this.ctx.storage.get<Stored>(KEY)) ?? {};
  }

  private async sealAs(value: string, field: string): Promise<Sealed> {
    return { sealed: await seal(value, this.env.BLUE_CHANNEL_ENCRYPTION_KEY, "selfhost-setup", field), at: new Date().toISOString() };
  }

  private open(value: Sealed, field: string): Promise<string> {
    return unseal(value.sealed, this.env.BLUE_CHANNEL_ENCRYPTION_KEY, "selfhost-setup", field);
  }
}
