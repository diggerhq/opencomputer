// The public error of the HTTP API (spec 34.2), declared once: `{ error: { code, message, requestId,
// retryable, ...extra } }` with the status the code maps to. One class per status, so a generated
// client decodes a reply by its status; the stable `code` is in the body. An actor's refusal becomes
// one of these in refusals.ts and nowhere else. This file imports no server code: the SDK and
// the api-edge may import it.

import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

const ErrorBody = Schema.StructWithRest(
  Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    requestId: Schema.String,
    retryable: Schema.Boolean,
    field: Schema.optionalKey(Schema.String),
    reason: Schema.optionalKey(Schema.String),
    scope: Schema.optionalKey(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const fields = { error: ErrorBody };

export class InvalidRequest extends Schema.Error<InvalidRequest>("api/InvalidRequest")(fields, { httpApiStatus: 400 }) {}
export class Unauthenticated extends Schema.Error<Unauthenticated>("api/Unauthenticated")(fields, { httpApiStatus: 401 }) {}
export class Forbidden extends Schema.Error<Forbidden>("api/Forbidden")(fields, { httpApiStatus: 403 }) {}
export class NotFound extends Schema.Error<NotFound>("api/NotFound")(fields, { httpApiStatus: 404 }) {}
export class Conflict extends Schema.Error<Conflict>("api/Conflict")(fields, { httpApiStatus: 409 }) {}
export class Unavailable extends Schema.Error<Unavailable>("api/Unavailable")(fields, { httpApiStatus: 503 }) {}

export type ApiError = InvalidRequest | Unauthenticated | Forbidden | NotFound | Conflict | Unavailable;


/** The first issue of a failed decode as the API's `{ field, message }` (the documented messages). */
export function issueOf(issue: SchemaIssue.Issue): { field: string; message: string } {
  const [first] = SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues;
  const path = (first?.path ?? []).map((s) => String(typeof s === "object" ? s.key : s));
  if ((first?.message.startsWith("Unexpected key") || first?.message === "Expected no excess property") && path.length) return { field: path[0]!, message: `Unknown field ${path[0]}.` };
  if (first?.message === "Expected a valid JSON body") return { field: "", message: "The body is not JSON." };
  return { field: path[0] ?? "", message: first?.message ?? "The body is not valid." };
}
