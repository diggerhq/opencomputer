#!/usr/bin/env node
// `oc` — a thin CLI over the Agent Revisions deploy API (design 009 §10/§13). Everything it does
// is available via the SDK; this is sugar for the "an agent is a directory" workflow.
//
//   oc deploy [dir=.] [--no-activate]   bundle agent.toml + prompt.md + skills/ → deploy a revision
//   oc rollback <agent> <ref>           activate an earlier revision (id or number)
//   oc revisions <agent> [get <ref>]    list revisions (or show one)
//
// Auth: OPENCOMPUTER_API_KEY (required). Base URL: OPENCOMPUTER_BASE_URL (default /v3 prod).

import { OpenComputer } from "./agents/client.js";
import { deployAgentDir } from "./agents/node-deploy.js";

function client(): OpenComputer {
  const apiKey = process.env.OPENCOMPUTER_API_KEY;
  if (!apiKey) fail("OPENCOMPUTER_API_KEY is not set");
  return new OpenComputer({ apiKey: apiKey!, baseUrl: process.env.OPENCOMPUTER_BASE_URL });
}

function fail(msg: string): never {
  console.error(`oc: ${msg}`);
  process.exit(1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "deploy": {
      const args = rest.filter((a) => !a.startsWith("-"));
      const dir = args[0] ?? ".";
      const activate = !rest.includes("--no-activate");
      const r = await deployAgentDir(client(), dir, { activate });
      const rev = r.deploy.revision;
      console.log(`deployed ${r.agentName} (${r.agentId}) → rev #${rev.number} ${rev.digest.slice(0, 19)} [${r.deploy.result}]${rev.active ? " active" : " (not activated)"}`);
      break;
    }
    case "rollback": {
      const [agent, ref] = rest;
      if (!agent || !ref) fail("usage: oc rollback <agent> <ref>");
      const r = await client().agents.rollback(agent, /^\d+$/.test(ref) ? Number(ref) : ref);
      console.log(`active revision → ${r.activeRevisionId}`);
      break;
    }
    case "revisions": {
      const [agent, sub, ref] = rest;
      if (!agent) fail("usage: oc revisions <agent> [get <ref>]");
      const oc = client();
      if (sub === "get") {
        if (!ref) fail("usage: oc revisions <agent> get <ref>");
        const rev = await oc.agents.revisions.get(agent, /^\d+$/.test(ref) ? Number(ref) : ref);
        console.log(JSON.stringify(rev, null, 2));
      } else {
        const { data } = await oc.agents.revisions.list(agent);
        for (const r of data) console.log(`#${r.number}\t${r.id}\t${r.digest.slice(0, 19)}\t${r.active ? "active" : ""}`);
      }
      break;
    }
    default:
      console.log("usage: oc <deploy|rollback|revisions> …");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
