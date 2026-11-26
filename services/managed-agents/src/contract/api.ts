// The route table of the public API under /v1/computer, declared once with Effect HttpApi: method,
// path, scope, body schema, success and error shapes. The Worker serves it (serve.ts), the api-edge's
// scope table is read from it (`scopeTable`), and the SDK client is derived from it
// (`HttpApiClient.make(ComputerApi)`). It imports no server code.
//
// Spike: one group (the organization's settings). The rest of api-http.ts joins group by group.

import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";

import type { ApiScope } from "../computer/api-types.js";
import { OrgSettings, SettingsPatch } from "./settings.js";
import { Forbidden, InvalidRequest, Unauthenticated, Unavailable } from "./errors.js";

/** The scope an endpoint needs; null when any principal of the org may call it. */
export const RequiredScope = Context.Reference<ApiScope | null>("opencomputer/http/api/RequiredScope", { defaultValue: () => null });

/** Checks the principal's scope against the endpoint's `RequiredScope`. */
export class Authorize extends HttpApiMiddleware.Service<Authorize>()("opencomputer/http/api/Authorize", {
  error: [Unauthenticated, Forbidden],
}) {}

/** A body, query or path that fails its schema is the public `invalid_request`, never Effect's own shape. */
export class PublicSchemaErrors extends HttpApiMiddleware.Service<PublicSchemaErrors>()("opencomputer/http/api/PublicSchemaErrors", {
  error: InvalidRequest,
}) {}

const Settings = Schema.Struct({ settings: OrgSettings });

export class SettingsGroup extends HttpApiGroup.make("settings")
  .add(HttpApiEndpoint.get("get", "/settings", { success: Settings, error: Unavailable }))
  .add(
    HttpApiEndpoint.patch("patch", "/settings", { payload: SettingsPatch, success: Settings, error: [Forbidden, InvalidRequest, Unavailable] }).annotate(
      RequiredScope,
      "sessions:write",
    ),
  ) {}

/** Bodies are strict (an unknown field is refused, as Org refuses it); headers are not (transport headers). */
export class ComputerApi extends HttpApi.make("computer")
  .add(SettingsGroup)
  .middleware(Authorize)
  .middleware(PublicSchemaErrors)
  .annotate(HttpApi.ParseOptions, { onExcessProperty: "error" })
  .annotate(HttpApi.HeadersParseOptions, {}) {}

/** `{ method, path, scope }` per endpoint: what the api-edge's route table holds by hand today. */
export function scopeTable(): { method: string; path: string; scope: ApiScope | null }[] {
  const rows: { method: string; path: string; scope: ApiScope | null }[] = [];
  HttpApi.reflect(ComputerApi, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, mergedAnnotations }) =>
      rows.push({ method: endpoint.method, path: endpoint.path, scope: Context.get(mergedAnnotations, RequiredScope) }),
  });
  return rows;
}
