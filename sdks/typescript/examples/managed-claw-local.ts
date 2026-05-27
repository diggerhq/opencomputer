import { ManagedClaw } from "../src/index.js";

async function main() {
  const apiUrl = process.env.CLAWPUTER_API_URL ?? "http://localhost:8081";
  const claw = new ManagedClaw({
    apiUrl,
    apiKey: process.env.CLAWPUTER_API_KEY,
    opencomputerApiKey: process.env.OPENCOMPUTER_API_KEY,
  });

  const fleet = await claw.fleets.create({
    name: "Local Smoke Fleet",
    instructions: "You are a concise assistant.",
    model: "openrouter/openai/gpt-5.5",
    runtime: {
      image: process.env.OPENCLAW_IMAGE ?? "opencomputerdeveuacr.azurecr.io/openclaw-managed:2026.5.2-npm",
      sandboxTimeoutSeconds: 0,
    },
    tools: {
      browser: true,
      filesystem: true,
      shell: false,
    },
  });

  console.log("fleet created:", fleet.id);

  const fetchedFleet = await claw.fleets.get(fleet.id);
  console.log("fleet fetched:", fetchedFleet.id, fetchedFleet.runtime.image);

  const agent = await claw.agents.getOrCreate({
    externalUserId: process.env.MANAGED_CLAW_TEST_USER ?? "local-test-user",
    displayName: "Local Test User",
    fleetId: fleet.id,
  });

  console.log("agent:", {
    id: agent.id,
    status: agent.status,
    sandboxId: agent.sandboxId,
    runtimeImage: agent.runtimeImage,
  });

  const fetchedAgent = await claw.agents.get(agent.id);
  console.log("agent fetched:", fetchedAgent.id, fetchedAgent.status);

  const reply = await claw.agents.sendMessage(agent.id, "Say hello in one short sentence.");
  console.log("reply:", reply.replyText);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
