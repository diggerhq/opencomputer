// The organization's settings (spec 36.1) as they cross the wire: the one declaration. Org decodes a
// patch with it (org/settings.ts), the HTTP API declares its body with it (contract/api.ts), and the
// SDK client is derived from that declaration. Pure: no server code.

import * as Schema from "effect/Schema";

export const ApiAccessDefault = Schema.Literals(["owner", "org"]).annotate({ message: "apiAccessDefault is owner or org." });

export const OrgSettings = Schema.Struct({ apiAccessDefault: ApiAccessDefault });
export type OrgSettings = typeof OrgSettings.Type;

/** A PATCH body: the fields to change, at least one, nothing else. */
export const SettingsPatch = Schema.Struct({ apiAccessDefault: Schema.optionalKey(ApiAccessDefault) }).check(
  Schema.makeFilter((patch) => Object.keys(patch).length > 0 || "The body names nothing to change."),
);
export type SettingsPatch = typeof SettingsPatch.Type;
