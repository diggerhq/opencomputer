// Who is calling and what they may reach, provided per request by the Worker (never built from
// module state): the principal the edge attached, this request's id, and Org's stub.

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrgRpc } from "../../actor/contracts.js";
import type { Principal } from "../../actor/principal.js";
import { Unavailable } from "../../contract/errors.js";

export class CurrentRequest extends Context.Service<CurrentRequest, {
  readonly principal: Principal;
  readonly requestId: string;
  readonly org: OrgRpc;
  /** Time spent awaiting actors, for the request's `httpapi.request`. */
  readonly timed: <T>(call: Promise<T>) => Promise<T>;
}>()("opencomputer/http/api/CurrentRequest") {}

/** A call to Org as this request's principal; an actor that cannot answer is the public 503. */
export const callOrg = <T>(call: (org: OrgRpc, p: Principal) => Promise<T>) =>
  CurrentRequest.use(({ org, principal, timed, requestId }) =>
    Effect.tryPromise({
      try: () => timed(call(org, principal)),
      catch: () => new Unavailable({ error: { code: "unavailable", message: "The organization is unavailable; retry.", requestId, retryable: true, retryAfterMs: 1_000 } }),
    }),
  );

/**
 * CurrentRequest from a middleware. HttpApi types a middleware's `requires` as a layer-time service, not
 * a per-request one, so middleware reads the request's context untyped; the Worker always provides it.
 */
export const currentInMiddleware = Effect.flatMap(Effect.serviceOption(CurrentRequest), (c) =>
  Option.isSome(c) ? Effect.succeed(c.value) : Effect.die(new Error("CurrentRequest was not provided")),
);
