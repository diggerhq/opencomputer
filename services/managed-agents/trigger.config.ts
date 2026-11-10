import { defineConfig } from "@trigger.dev/sdk";

// The trigger.dev project the tasks deploy to.
const project = process.env.TRIGGER_PROJECT_REF?.trim();
if (!project) throw new Error("set TRIGGER_PROJECT_REF");

export default defineConfig({
  project,
  dirs: ["./trigger"],
  runtime: "node-22",
  maxDuration: 20 * 60,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
});
