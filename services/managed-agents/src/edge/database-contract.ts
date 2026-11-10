import type { ProjectEnvironmentName } from "../protocol.js";
import { isProjectEnvironmentName } from "./project-scope.js";

export interface DatabaseMigration {
  name: string;
  checksum: string;
  sql: string;
}

export interface DatabaseScope {
  accountId: string;
  projectId: string;
  environment: ProjectEnvironmentName;
}

export type DatabaseValue = string | number | null;

export interface DatabaseResult {
  columns: string[];
  rows: Array<Record<string, DatabaseValue>>;
  rowsAffected: number;
  truncated: boolean;
}

export interface ApplyDatabaseMigrationsOutcome {
  applied: string[];
}

export interface DatabaseOperations {
  applyMigrations(
    scope: DatabaseScope,
    migrations: DatabaseMigration[],
  ): Promise<ApplyDatabaseMigrationsOutcome>;
  query(sql: string, parameters: DatabaseValue[]): Promise<DatabaseResult>;
  execute(sql: string, parameters: DatabaseValue[]): Promise<DatabaseResult>;
}

export type DatabaseNamespace = DurableObjectNamespace<
  DatabaseOperations & Rpc.DurableObjectBranded
>;

export const DATABASE_LIMITS = {
  migrationBytes: 256 * 1024,
  migrationsBytes: 1024 * 1024,
  sqlBytes: 32 * 1024,
  parameters: 100,
  parametersBytes: 64 * 1024,
  rows: 200,
  resultBytes: 256 * 1024,
} as const;

function sqlShape(sql: string): { first: string; tokens: string[]; semicolons: number[] } {
  const tokens: string[] = [];
  const semicolons: number[] = [];
  let token = "";
  let state: "normal" | "single" | "double" | "backtick" | "bracket" | "line" | "block" = "normal";
  const flush = () => {
    if (token) tokens.push(token.toUpperCase());
    token = "";
  };
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (state === "line") {
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") {
        state = "normal";
        index += 1;
      }
      continue;
    }
    if (state !== "normal") {
      const closing = state === "single" ? "'" : state === "double" ? '"' : state === "backtick" ? "`" : "]";
      if (character === closing) {
        if ((state === "single" || state === "double") && next === closing) index += 1;
        else state = "normal";
      }
      continue;
    }
    if (character === "-" && next === "-") {
      flush();
      state = "line";
      index += 1;
    } else if (character === "/" && next === "*") {
      flush();
      state = "block";
      index += 1;
    } else if (character === "'") {
      flush();
      state = "single";
    } else if (character === '"') {
      flush();
      state = "double";
    } else if (character === "`") {
      flush();
      state = "backtick";
    } else if (character === "[") {
      flush();
      state = "bracket";
    } else if (character === ";") {
      flush();
      semicolons.push(index);
    } else if (/[A-Za-z_]/.test(character)) {
      token += character;
    } else {
      flush();
    }
  }
  flush();
  if (state === "single" || state === "double" || state === "backtick" || state === "bracket" || state === "block") {
    throw new Error("SQL contains an unterminated string, identifier, or comment");
  }
  return { first: tokens[0] ?? "", tokens, semicolons };
}

function assertOneStatement(sql: string): { first: string; tokens: string[] } {
  if (!sql.trim()) throw new Error("SQL must not be empty");
  if (new TextEncoder().encode(sql).byteLength > DATABASE_LIMITS.sqlBytes) {
    throw new Error("SQL cannot exceed 32 KiB");
  }
  const shape = sqlShape(sql);
  if (shape.semicolons.length > 1) throw new Error("Exactly one SQL statement is allowed");
  if (shape.semicolons.length === 1) {
    const tail = sql.slice(shape.semicolons[0]! + 1);
    const tailShape = sqlShape(tail);
    if (tailShape.tokens.length || tailShape.semicolons.length) {
      throw new Error("Exactly one SQL statement is allowed");
    }
  }
  return shape;
}

const MUTATING_SQL = new Set([
  "INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "ALTER", "DROP",
  "ATTACH", "DETACH", "VACUUM", "REINDEX", "ANALYZE", "BEGIN", "COMMIT",
  "ROLLBACK", "SAVEPOINT", "RELEASE", "PRAGMA",
]);

export function assertDatabaseQuerySql(sql: string): void {
  const shape = assertOneStatement(sql);
  if (!new Set(["SELECT", "WITH", "EXPLAIN"]).has(shape.first)) {
    throw new Error("database_query accepts SELECT, WITH, or EXPLAIN only");
  }
  if (shape.tokens.some((token) => MUTATING_SQL.has(token))) {
    throw new Error("database_query must be read-only");
  }
}

export function assertDatabaseExecuteSql(sql: string): void {
  const shape = assertOneStatement(sql);
  if (!new Set(["INSERT", "UPDATE", "DELETE", "REPLACE"]).has(shape.first)) {
    throw new Error("database_execute accepts INSERT, UPDATE, DELETE, or REPLACE only");
  }
  const forbidden = new Set([
    "CREATE", "ALTER", "DROP", "ATTACH", "DETACH", "VACUUM", "REINDEX",
    "PRAGMA", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE",
  ]);
  if (shape.tokens.some((token) => forbidden.has(token))) {
    throw new Error("database_execute does not accept DDL or transaction control");
  }
}

export function validateDatabaseParameters(value: unknown): DatabaseValue[] {
  if (!Array.isArray(value) || value.length > DATABASE_LIMITS.parameters) {
    throw new Error("Database parameters must be an array of at most 100 values");
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > DATABASE_LIMITS.parametersBytes) {
    throw new Error("Database parameters cannot exceed 64 KiB");
  }
  return value.map((parameter) => {
    if (parameter === null || typeof parameter === "string") return parameter;
    if (typeof parameter === "boolean") return parameter ? 1 : 0;
    if (typeof parameter === "number" && Number.isFinite(parameter)) return parameter;
    throw new Error("Database parameters must be strings, finite numbers, booleans, or null");
  });
}

export function databaseObjectName(
  accountId: string,
  projectId: string,
  environment: ProjectEnvironmentName,
): string {
  if (!accountId || accountId.includes(":")) {
    throw new Error("Database needs an account id without ':'");
  }
  if (!projectId || projectId.startsWith("project:") || projectId.includes(":")) {
    throw new Error("Database needs a project; an agent outside a project has no database scope");
  }
  if (!isProjectEnvironmentName(environment)) {
    throw new Error("Database needs a canonical project environment");
  }
  return `database:${accountId}:${projectId}:${environment}`;
}
