// OC repo-plane tools (design 013 §5.2) — `defineTool`s an agent adds to reach the platform's
// checkout/publish capabilities from inside a Flue turn. They POST to a Flue-session-authed OC endpoint
// that runs the EXISTING `runPublishAction` → isolated repo-op → GitHub-App-mint path (identity stays the
// App; the DO never sees a git token). Consumed by W10; the endpoint contract is pinned there.

import { defineTool } from "@flue/runtime";
import * as v from "valibot";
import type { OcEnv } from "./gateway.js";

export interface OcRepoEnv extends OcEnv {
  /** Base URL of the Flue-session-authed OC repo/publish endpoints (control plane). */
  OC_REPO_API?: string;
}

/** Build the OC repo tools bound to `env`. Add to a coding agent's `tools` in its initializer. */
export function ocRepoTools(env: OcRepoEnv) {
  const base = (env.OC_REPO_API ?? "").replace(/\/+$/, "");
  const headers = () => ({ authorization: `Bearer ${env.OC_SESSION_TOKEN ?? ""}`, "content-type": "application/json" });

  return [
    defineTool({
      name: "publish_pull_request",
      description:
        "Open or update a GitHub pull request from the changes in the agent's workspace. Identity stays the OpenComputer GitHub App; requires an attached source repo on the session.",
      input: v.object({
        title: v.string(),
        body: v.string(),
        branch: v.optional(v.string()),
      }),
      async run(ctx) {
        if (!base) throw new Error("[oc-flue] publish_pull_request: OC_REPO_API is not configured.");
        const resp = await fetch(`${base}/publish`, { method: "POST", headers: headers(), body: JSON.stringify(ctx.input) });
        const text = await resp.text();
        if (!resp.ok) throw new Error(`publish_pull_request failed: ${resp.status} ${text.slice(0, 200)}`);
        return text;
      },
    }),
  ];
}
