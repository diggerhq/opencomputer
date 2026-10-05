import ts from "typescript";

/** Where in an agent's source a compiler requirement was not met, when the compiler had the node in hand. */
export interface CompilerSourcePosition {
  /** Module path relative to the agent directory, e.g. `agent.ts` or `tools/lookup.ts`. */
  file: string;
  line: number;
  column: number;
}

/**
 * A source-shape requirement the agent compiler enforces: literal IDs,
 * origins, methods and path prefixes, one declaration per id, and so on. The
 * message is what deploy and secret upload have always printed; the code and
 * position let `doctor` report the same requirement structurally.
 */
export class CompilerError extends Error {
  constructor(
    message: string,
    readonly code: string = "compiler_error",
    readonly position?: CompilerSourcePosition,
  ) {
    super(message);
    this.name = "CompilerError";
  }
}

export function compilerError(
  message: string,
  code: string,
  node?: ts.Node,
): CompilerError {
  const source = node?.getSourceFile();
  if (!node || !source) return new CompilerError(message, code);
  const { line, character } = source.getLineAndCharacterOfPosition(
    node.getStart(source),
  );
  return new CompilerError(message, code, {
    file: source.fileName,
    line: line + 1,
    column: character + 1,
  });
}

/** Stable code for a compiler failure: its own when it carries one, `compiler_error` otherwise. */
export function compilerErrorCode(error: unknown): string {
  return error instanceof CompilerError ? error.code : "compiler_error";
}
