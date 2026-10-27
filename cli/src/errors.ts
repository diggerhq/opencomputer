import { APIError } from "./api.js";
import { paywallFor } from "./billing.js";

export interface StructuredCLIError {
  code: string;
  message: string;
  hint: string;
  details?: unknown;
}

export class CLIError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function structuredError(error: unknown): StructuredCLIError {
  if (error instanceof CLIError) {
    return {
      code: error.code,
      message: error.message,
      hint: error.hint,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof APIError) {
    if (error.code === "insufficient_credits" || error.status === 402) {
      const url = error.actionUrl;
      const paywall = paywallFor(error.haltReason);
      if (paywall) {
        return {
          code: "insufficient_credits",
          message,
          // Worded for the user, so an agent can relay it as is.
          hint:
            `${paywall.why} ${paywall.action}` +
            (url ? ` at ${url}` : " on the Billing page") +
            ", then run the command again. Do not retry until then.",
          details: {
            status: error.status,
            apiCode: error.code ?? "insufficient_credits",
            haltReason: error.haltReason,
            ...(url ? { upgradeUrl: url } : {}),
          },
        };
      }
      // A $200 Pro org that has used its monthly credits gets the plain billing
      // page (no `?plan=`): there is nothing to upgrade to, so don't say so.
      const renewOnly = url !== undefined && !url.includes("?plan=");
      return {
        code: "insufficient_credits",
        message,
        hint: renewOnly
          ? `Out of this month's credits \u2014 do not retry. They renew next billing period; the user can review billing at ${url}.`
          : "Out of credits \u2014 do not retry. Tell the user to upgrade to Pro ($200/mo)" +
          (url ? ` at ${url}` : " with `opencomputer upgrade`") +
          " to keep going, then run the command again.",
        details: {
          status: error.status,
          apiCode: error.code ?? "insufficient_credits",
          ...(url ? { upgradeUrl: url } : {}),
        },
      };
    }
    const code =
      error.status === 401 || error.status === 403
        ? "authentication_required"
        : error.status === 404
          ? "resource_not_found"
          : error.status === 409
            ? "conflict"
            : error.status === 412
              ? "precondition_failed"
              : error.status === 413
                ? "payload_too_large"
                : error.status === 428
                  ? "precondition_required"
                  : "api_request_failed";
    const hint =
      code === "authentication_required"
        ? "Run `opencomputer login` or set OPENCOMPUTER_API_KEY."
        : code === "resource_not_found"
          ? "Check the bound project and resource identifier, then retry."
          : code === "conflict"
            ? "Read the existing resource and retry with the same idempotency key."
            : code === "precondition_failed"
              ? "Read the current state, reconcile your change, and retry; a deleted ID cannot be reused."
              : code === "payload_too_large"
                ? "Shorten the content to fit the documented byte limit and retry."
                : code === "precondition_required"
                  ? "Send the precondition the operation requires and retry."
                  : "Retry the command; if it persists, inspect `opencomputer logs --json`.";
    return {
      code,
      message,
      hint,
      details: {
        status: error.status,
        ...(error.code ? { apiCode: error.code } : {}),
      },
    };
  }
  if (/not logged in/i.test(message)) {
    return {
      code: "authentication_required",
      message,
      hint: "Run `opencomputer login` or set OPENCOMPUTER_API_KEY.",
    };
  }
  if (/not connected to a cloud project|opencomputer link/i.test(message)) {
    return {
      code: "binding_required",
      message,
      hint:
        "Run `opencomputer link --project <id|slug>` or `opencomputer link --create-project <name>`.",
    };
  }
  if (/not inside an OpenComputer app|No OpenComputer project found/i.test(message)) {
    return {
      code: "project_not_found",
      message,
      hint: "Run the command inside a project, or create one with `opencomputer init <directory>`.",
    };
  }
  if (/unexpected argument|unknown command|requires a value|usage:|must be|choose either/i.test(message)) {
    return {
      code: "invalid_arguments",
      message,
      hint: "Run `opencomputer --help` and pass explicit non-interactive arguments.",
    };
  }
  return {
    code: "command_failed",
    message,
    hint: "Check the command inputs and local project state, then retry.",
  };
}
