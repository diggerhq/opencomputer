/**
 * The browser-session contract: what `useBrowser()` selects and the fixed
 * tool names the selection reserves.
 *
 * This module is shared verbatim by `@opencomputer/agent`
 * (`agent/src/browser.ts`) and the CLI (`cli/src/browser.ts`), where the
 * compiler reads the same constants while extracting declarations from agent
 * source. The two copies must stay byte-identical; a CLI test enforces it.
 * Keep the module free of imports so it can be inlined.
 */

/**
 * The one browser a project enables today. Named browsers are a reserved
 * shape: ids validate through the same rules so a later manifest can carry
 * more than one declaration without changing call sites.
 */
export const BROWSER_DEFAULT_ID = "browser";
export const BROWSER_ID_MAX_LENGTH = 64;
/** Injected into every browser tool's model-facing schema to select a browser. */
export const BROWSER_RESERVED_ARGUMENT = "browser";

const BROWSER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The fixed host tools a selected browser exposes: `browser_<name>`. */
export const BROWSER_TOOLS: readonly string[] = Object.freeze([
  "navigate",
  "snapshot",
  "click",
  "type",
  "scroll",
  "screenshot",
  "evaluate",
]);

/** The model-facing tool names a browser selection reserves. */
export function browserToolNames(): string[] {
  return BROWSER_TOOLS.map((name) => `${BROWSER_RESERVED_ARGUMENT}_${name}`);
}

export function browserId(value: unknown, kind: string): string {
  const id = value === undefined ? BROWSER_DEFAULT_ID : typeof value === "string" ? value.trim() : "";
  if (!id) throw new Error(`${kind} requires a non-empty id`);
  if (!BROWSER_ID_PATTERN.test(id)) {
    throw new Error(
      `${kind} IDs must use lowercase letters, numbers, and single hyphens`,
    );
  }
  if (id.length > BROWSER_ID_MAX_LENGTH) {
    throw new Error(
      `${kind} IDs must contain at most ${BROWSER_ID_MAX_LENGTH} characters`,
    );
  }
  return id;
}

/** A browser the project enables; today projects declare only the default one. */
export interface BrowserReference {
  readonly id: string;
}

/**
 * The projection the host resolved for the render's selection, or a render
 * failure when the project does not enable browser sessions. It carries the
 * selected id so an agent can report what it drives; connection details
 * never reach agent code.
 */
export interface BrowserProjection {
  readonly id: string;
}

export function browserProjection(
  id: string,
  value: unknown,
): BrowserProjection {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).id !== "string" ||
    (value as Record<string, unknown>).id !== id
  ) {
    throw new Error(
      `Browser ${JSON.stringify(id)} is not enabled for this project; set browser: true in opencomputer/project.ts`,
    );
  }
  return value as BrowserProjection;
}
