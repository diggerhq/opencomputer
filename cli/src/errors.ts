import { APIError } from "./api.js";

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
    const code =
      error.status === 401 || error.status === 403
        ? "authentication_required"
        : error.status === 404
          ? "resource_not_found"
          : error.status === 409
            ? "conflict"
            : "api_request_failed";
    const hint =
      code === "authentication_required"
        ? "Run `opencomputer login` or set OPENCOMPUTER_API_KEY."
        : code === "resource_not_found"
          ? "Check the bound project and resource identifier, then retry."
          : code === "conflict"
            ? "Read the existing resource and retry with the same idempotency key."
            : "Retry the command; if it persists, inspect `opencomputer logs --json`.";
    return { code, message, hint, details: { status: error.status } };
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
