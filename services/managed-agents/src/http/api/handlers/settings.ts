// GET and PATCH /settings (sessions.mdx#organization-default): Org's. The body was decoded against
// the declaration before this runs; Org decodes it again with the same schema, as it would for any
// caller of its RPC.

import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { callOrg } from "../caller.js";
import { fromRefusal } from "../refusals.js";
import { ComputerApi } from "../../../contract/api.js";

export const SettingsHandlers = HttpApiBuilder.group(ComputerApi, "settings", (handlers) =>
  handlers
    .handle("get", () => Effect.map(callOrg((org, p) => org.settings(p)), (settings) => ({ settings })))
    .handle("patch", ({ payload }) =>
      Effect.flatMap(callOrg((org, p) => org.setSettings(p, payload)), (r) => (r.ok ? Effect.succeed({ settings: r.settings }) : fromRefusal(r))),
    ),
);
