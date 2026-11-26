// The declared API (routes.ts) as a fetch handler: built once at module scope, as Effect requires on
// Workers (no request state lives in it); each request brings its own CurrentRequest.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";

import { issueOf } from "../../contract/errors.js";
import { CurrentRequest, currentInMiddleware } from "./caller.js";
import { SettingsHandlers } from "./handlers/settings.js";
import { failWith } from "./refusals.js";
import { Authorize, ComputerApi, PublicSchemaErrors, RequiredScope } from "../../contract/api.js";

const AuthorizeLive = Layer.succeed(Authorize, (httpEffect, { endpoint }) =>
  Effect.gen(function* () {
    const { principal, requestId } = yield* currentInMiddleware;
    const scope = Context.get(endpoint.annotations, RequiredScope);
    if (scope && !principal.scopes.includes(scope)) {
      return yield* failWith(requestId, 403, "forbidden", `This key does not have the ${scope} scope.`, { reason: "missing_scope", scope });
    }
    return yield* httpEffect;
  }),
);

const PublicSchemaErrorsLive = HttpApiMiddleware.layerSchemaErrorTransform(PublicSchemaErrors, (error) =>
  error.kind === "ResponseHeaders"
    ? Effect.die(error)
    : Effect.flatMap(currentInMiddleware, ({ requestId }) => {
        const { field, message } = issueOf(error.cause.issue);
        return failWith(requestId, 400, "invalid_request", message, { field });
      }),
);

const app = HttpRouter.toWebHandler(
  HttpApiBuilder.layer(ComputerApi).pipe(
    Layer.provide(SettingsHandlers.pipe(Layer.provide([AuthorizeLive, PublicSchemaErrorsLive]))),
    Layer.provide(HttpServer.layerServices),
  ),
  { disableLogger: true },
);

/** Serves one request of the declared API; `suffix` is the path after `/v1/computer`. */
export function serveDeclared(request: Request, suffix: string, current: CurrentRequest["Service"]): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = suffix;
  return app.handler(new Request(url, request), Context.make(CurrentRequest, current));
}
