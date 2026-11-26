import { env, runInDurableObject } from "cloudflare:test";
import { seal } from "../../src/crypto/seal.js";

interface Link {
  teamId: string;
  teamName: string;
  botUserId: string;
  botToken: string;
  installerUserId?: string;
}

/**
 * A Computer with a Slack workspace's link as stored before the Slack actor held it: the settings its own
 * Slack calls (command replies, direct messages) still read until the import.
 */
export async function linkSlack(stub: DurableObjectStub, org: string, link: Link): Promise<void> {
  const key = (env as unknown as { BLUE_CHANNEL_ENCRYPTION_KEY: string }).BLUE_CHANNEL_ENCRYPTION_KEY;
  const token = await seal(link.botToken, key, "slack-bot-token", `${org}\0${link.teamId}`);
  await runInDurableObject(stub, (instance) => {
    const computer = instance as unknown as { bind(org: string): void; put(key: string, value: string): void };
    computer.bind(org);
    computer.put("slackTeamId", link.teamId);
    computer.put("slackTeamName", link.teamName);
    computer.put("slackBotUserId", link.botUserId);
    if (link.installerUserId) computer.put("slackInstallerUserId", link.installerUserId);
    computer.put("slackBotToken", token);
  });
}
