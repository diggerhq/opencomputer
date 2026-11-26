import { readFile, writeFile } from "node:fs/promises";

import { Plugin } from "@opencode-ai/plugin-v2";

import { registerCodeTools } from "../../src/runtime/code-tools.js";
import { defineOpenCode2ReactivePlugin } from "../../src/runtime/opencode2-reactive-plugin.js";
import {
  modelRegistry,
  useModel,
  useSessionData,
  useTool,
  type AgentRenderRecord,
} from "../../src/runtime/reactive-agent.js";

interface ProbeState {
  providerTurn: number;
  stateVersion: number;
  unlocked: boolean;
}

function requiredPath(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the local probe plugin`);
  return value;
}

const statePath = requiredPath("OPENCOMPUTER_PROBE_STATE");
const recordsPath = requiredPath("OPENCOMPUTER_PROBE_RECORDS");
const contextsPath = requiredPath("OPENCOMPUTER_PROBE_CONTEXTS");

async function readState(): Promise<ProbeState> {
  return JSON.parse(await readFile(statePath, "utf8")) as ProbeState;
}

function probeAgent(): string {
  useModel({ provider: "probe", model: "reactive-test" });
  const unlocked = useSessionData<boolean>("unlocked") ?? false;
  useTool(unlocked ? "finish" : "unlock");
  return unlocked
    ? "The session is unlocked. Reply with exactly: complete"
    : "The session is locked. Call the unlock tool now.";
}

const reactive = defineOpenCode2ReactivePlugin({
  resolve: async (turn) => {
    const state = await readState();
    return {
      agent: probeAgent,
      input: {
        projectId: "prj_local_probe",
        deploymentId: "dep_local_probe",
        agentId: String(turn.openCodeAgentId),
        sessionId: String(turn.openCodeSessionId),
        responseId: "rsp_local_probe",
        providerTurn: state.providerTurn,
        stateVersion: state.stateVersion,
        state: { unlocked: state.unlocked },
        currentInput: turn.input,
      },
      registry: {
        tools: new Set(["unlock", "finish"]),
        models: modelRegistry([
          { provider: "probe", model: "reactive-test" },
        ]),
      },
    };
  },
  commit: async (record: AgentRenderRecord) => {
    const durableRecord = {
      providerTurn: record.providerTurn,
      stateVersion: record.stateVersion,
      instructions: record.render.instructions,
      enabledTools: record.enabledTools,
      model: record.model,
    };
    const previous = await readFile(recordsPath, "utf8").catch(() => "");
    await writeFile(
      recordsPath,
      `${previous}${JSON.stringify(durableRecord)}\n`,
      "utf8",
    );
  },
});

export default Plugin.define({
  id: "opencomputer.local-reactive-probe",
  setup: async (context) => {
    await registerCodeTools(
      context,
      requiredPath("OPENCOMPUTER_PROBE_TOOL_MANIFEST"),
      ["tools.js"],
      new Set(["unlock", "finish"]),
      {
        // A local probe has no Session object; the tuple is the probe's own.
        identity: async (call) => ({
          projectId: "probe",
          environment: "development",
          agentId: "probe",
          deploymentId: "probe",
          sessionId: "probe",
          turnId: "probe",
          ...call,
          providerCallId: call.toolCallId,
        }),
      },
    );
    await context.session.hook("context", async (event) => {
      const previous = await readFile(contextsPath, "utf8").catch(() => "");
      await writeFile(
        contextsPath,
        `${previous}${JSON.stringify({ tools: Object.keys(event.tools) })}\n`,
        "utf8",
      );
    });
    return reactive.setup(context);
  },
});
