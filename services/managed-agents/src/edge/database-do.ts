import { DurableObject } from "cloudflare:workers";
import {
  createClient as createLibsqlClient,
  type Client,
  type ResultSet,
} from "@libsql/client";
import { createClient as createTursoAdminClient } from "@tursodatabase/api";

import {
  DATABASE_LIMITS,
  assertDatabaseExecuteSql,
  assertDatabaseQuerySql,
  databaseObjectName,
  validateDatabaseParameters,
  type ApplyDatabaseMigrationsOutcome,
  type DatabaseMigration,
  type DatabaseOperations,
  type DatabaseResult,
  type DatabaseScope,
  type DatabaseValue,
} from "./database-contract.js";

const encoder = new TextEncoder();

export class DatabaseNotProvisionedError extends Error {
  constructor() {
    super("Database has not been provisioned");
    this.name = "DatabaseNotProvisionedError";
  }
}

export function isDatabaseNotProvisionedError(
  error: unknown,
): error is Error {
  return (
    error instanceof Error &&
    (error instanceof DatabaseNotProvisionedError ||
      error.name === "DatabaseNotProvisionedError" ||
      error.message === "Database has not been provisioned")
  );
}

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64(value: ArrayBuffer): string {
  const data = new Uint8Array(value);
  if (data.byteLength > DATABASE_LIMITS.resultBytes) {
    throw new Error("A database blob exceeded the result limit");
  }
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 8_192) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 8_192) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

interface DatabaseProviderEnv {
  TURSO_API_TOKEN?: string;
  TURSO_ORGANIZATION?: string;
  TURSO_GROUP?: string;
  TURSO_CREDENTIAL_ENCRYPTION_KEY?: string;
}

interface ProviderRow {
  [key: string]: SqlStorageValue;
  scope: string;
  database_name: string;
  database_id: string;
  hostname: string;
  token_ciphertext: string;
  token_iv: string;
}

interface ProviderCredentials {
  databaseName: string;
  databaseId: string;
  hostname: string;
  token: string;
}

function scopeIdentity(scope: DatabaseScope): string {
  return `${scope.accountId}:${scope.projectId}:${scope.environment}`;
}

function validScope(scope: DatabaseScope): void {
  databaseObjectName(scope.accountId, scope.projectId, scope.environment);
}

function identifierFragment(value: string, prefix: string, length: number): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const withoutPrefix = normalized.startsWith(prefix)
    ? normalized.slice(prefix.length)
    : normalized;
  return withoutPrefix.slice(0, length);
}

export async function providerDatabaseName(scope: DatabaseScope): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${scope.accountId}:${scope.projectId}:${scope.environment}`),
  );
  const hash = hex(digest);
  const organization = identifierFragment(scope.accountId, "acct", 5) || hash.slice(0, 5);
  const project = identifierFragment(scope.projectId, "prj", 8) || hash.slice(5, 13);
  const environment =
    scope.environment === "development"
      ? "dev"
      : scope.environment === "production"
        ? "prod"
        : "main";
  return `oc-${organization}-${project}-${environment}-${hash.slice(0, 10)}`;
}

function providerFailure(error: unknown, operation: string): Error {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
  return new Error(
    `Database provider ${operation} failed${status ? ` with HTTP ${status}` : ""}`,
  );
}

async function waitForProviderDatabase(hostname: string, token: string): Promise<void> {
  const delays = [0, 250, 500, 1_000, 2_000, 4_000];
  for (const [index, delay] of delays.entries()) {
    if (delay) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const client = createLibsqlClient({
      url: `https://${hostname}`,
      authToken: token,
    });
    try {
      await client.execute("SELECT 1");
      return;
    } catch (error) {
      if (index === delays.length - 1) {
        throw providerFailure(error, "readiness check");
      }
    } finally {
      client.close();
    }
  }
}

function jsonRpc(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export class ProjectDatabaseDurableObject
  extends DurableObject<Env>
  implements DatabaseOperations
{
  private provisioning?: Promise<ProviderCredentials>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _opencomputer_database_provider (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          scope TEXT NOT NULL,
          database_name TEXT NOT NULL,
          database_id TEXT NOT NULL,
          hostname TEXT NOT NULL,
          token_ciphertext TEXT NOT NULL,
          token_iv TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    });
  }

  private providerEnv(): Required<DatabaseProviderEnv> {
    const env = this.env as Env & DatabaseProviderEnv;
    if (
      !env.TURSO_API_TOKEN ||
      !env.TURSO_ORGANIZATION ||
      !env.TURSO_GROUP ||
      !env.TURSO_CREDENTIAL_ENCRYPTION_KEY
    ) {
      throw new Error("Database provider is not configured");
    }
    return {
      TURSO_API_TOKEN: env.TURSO_API_TOKEN,
      TURSO_ORGANIZATION: env.TURSO_ORGANIZATION,
      TURSO_GROUP: env.TURSO_GROUP,
      TURSO_CREDENTIAL_ENCRYPTION_KEY: env.TURSO_CREDENTIAL_ENCRYPTION_KEY,
    };
  }

  private async encryptionKey(): Promise<CryptoKey> {
    const encoded = this.providerEnv().TURSO_CREDENTIAL_ENCRYPTION_KEY;
    const key = fromBase64(encoded);
    if (key.byteLength !== 32) {
      throw new Error("Database credential encryption key must contain 32 bytes");
    }
    return crypto.subtle.importKey("raw", key, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }

  private async encryptToken(token: string): Promise<{ ciphertext: string; iv: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await this.encryptionKey(),
      encoder.encode(token),
    );
    return {
      ciphertext: toBase64(new Uint8Array(ciphertext)),
      iv: toBase64(iv),
    };
  }

  private async decryptToken(ciphertext: string, iv: string): Promise<string> {
    const cleartext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv) },
      await this.encryptionKey(),
      fromBase64(ciphertext),
    );
    return new TextDecoder().decode(cleartext);
  }

  private providerRow(): ProviderRow | undefined {
    return this.ctx.storage.sql
      .exec<ProviderRow>(
        `SELECT scope, database_name, database_id, hostname,
                token_ciphertext, token_iv
         FROM _opencomputer_database_provider WHERE singleton = 1`,
      )
      .toArray()[0];
  }

  private async credentials(scope?: DatabaseScope): Promise<ProviderCredentials> {
    const existing = this.providerRow();
    if (existing) {
      if (scope && existing.scope !== scopeIdentity(scope)) {
        throw new Error("Database provider scope does not match this environment");
      }
      return {
        databaseName: existing.database_name,
        databaseId: existing.database_id,
        hostname: existing.hostname,
        token: await this.decryptToken(existing.token_ciphertext, existing.token_iv),
      };
    }
    if (!scope) throw new DatabaseNotProvisionedError();
    if (!this.provisioning) {
      this.provisioning = this.provision(scope).finally(() => {
        this.provisioning = undefined;
      });
    }
    return this.provisioning;
  }

  private async provision(scope: DatabaseScope): Promise<ProviderCredentials> {
    validScope(scope);
    const provider = this.providerEnv();
    const name = await providerDatabaseName(scope);
    const admin = createTursoAdminClient({
      org: provider.TURSO_ORGANIZATION,
      token: provider.TURSO_API_TOKEN,
    });
    let database: { name: string; id: string; hostname: string };
    try {
      database = await admin.databases.get(name);
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status?: unknown }).status)
          : undefined;
      if (status !== 404) throw providerFailure(error, "lookup");
      try {
        database = await admin.databases.create(name, {
          group: provider.TURSO_GROUP,
        });
      } catch (createError) {
        const createStatus =
          createError && typeof createError === "object" && "status" in createError
            ? Number((createError as { status?: unknown }).status)
            : undefined;
        if (createStatus !== 409) throw providerFailure(createError, "provisioning");
        database = await admin.databases.get(name).catch((getError: unknown) => {
          throw providerFailure(getError, "lookup after provisioning conflict");
        });
      }
    }
    const token = await admin.databases
      .createToken(name, { authorization: "full-access" })
      .catch((error: unknown) => {
        throw providerFailure(error, "credential creation");
      });
    await waitForProviderDatabase(database.hostname, token.jwt);
    const encrypted = await this.encryptToken(token.jwt);
    const timestamp = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO _opencomputer_database_provider (
         singleton, scope, database_name, database_id, hostname,
         token_ciphertext, token_iv, created_at, updated_at
       ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      scopeIdentity(scope),
      database.name,
      database.id,
      database.hostname,
      encrypted.ciphertext,
      encrypted.iv,
      timestamp,
      timestamp,
    );
    return {
      databaseName: database.name,
      databaseId: database.id,
      hostname: database.hostname,
      token: token.jwt,
    };
  }

  private async client(scope?: DatabaseScope) {
    const credentials = await this.credentials(scope);
    return createLibsqlClient({
      url: `https://${credentials.hostname}`,
      authToken: credentials.token,
    });
  }

  async applyMigrations(
    scope: DatabaseScope,
    migrations: DatabaseMigration[],
  ): Promise<ApplyDatabaseMigrationsOutcome> {
    let totalBytes = 0;
    const names = new Set<string>();
    for (const migration of migrations) {
      const migrationBytes = bytes(migration.sql);
      totalBytes += migrationBytes;
      if (
        !/^\d{3,}_[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?\.sql$/.test(migration.name) ||
        names.has(migration.name) ||
        !/^[a-f0-9]{64}$/.test(migration.checksum) ||
        !migration.sql.trim() ||
        migrationBytes > DATABASE_LIMITS.migrationBytes ||
        totalBytes > DATABASE_LIMITS.migrationsBytes
      ) {
        throw new Error(`Database migration ${migration.name || "<unnamed>"} is invalid`);
      }
      names.add(migration.name);
      const checksum = hex(
        await crypto.subtle.digest("SHA-256", encoder.encode(migration.sql)),
      );
      if (checksum !== migration.checksum) {
        throw new Error(`Database migration ${migration.name} checksum does not match its SQL`);
      }
    }

    let client: Client | undefined;
    const applied: string[] = [];
    try {
      client = await this.client(scope);
      await client.execute(`CREATE TABLE IF NOT EXISTS _opencomputer_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`);
      const history = await client.execute(
        "SELECT name, checksum FROM _opencomputer_migrations",
      );
      const checksums = new Map(
        history.rows.map((row) => [String(row.name), String(row.checksum)]),
      );
      const pending: DatabaseMigration[] = [];
      for (const migration of migrations) {
        const existing = checksums.get(migration.name);
        if (existing && existing !== migration.checksum) {
          throw new Error(`${migration.name} changed after it was applied`);
        }
        if (!existing) pending.push(migration);
      }
      if (pending.length) {
        const transaction = await client.transaction("write");
        try {
          for (const migration of pending) {
            await transaction.executeMultiple(migration.sql);
            await transaction.execute({
              sql: "INSERT INTO _opencomputer_migrations (name, checksum, applied_at) VALUES (?, ?, ?)",
              args: [migration.name, migration.checksum, new Date().toISOString()],
            });
            applied.push(migration.name);
          }
          await transaction.commit();
        } catch (error) {
          await transaction.rollback().catch(() => undefined);
          throw error;
        }
      }
    } catch (error) {
      throw new Error(
        `Database migration failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      client?.close();
    }
    return { applied };
  }

  async query(sql: string, parameters: DatabaseValue[]): Promise<DatabaseResult> {
    assertDatabaseQuerySql(sql);
    return this.run(sql, parameters, false);
  }

  async execute(sql: string, parameters: DatabaseValue[]): Promise<DatabaseResult> {
    assertDatabaseExecuteSql(sql);
    return this.run(sql, parameters, true);
  }

  private async run(
    sql: string,
    parameters: DatabaseValue[],
    write: boolean,
  ): Promise<DatabaseResult> {
    const client = await this.client();
    let result: ResultSet;
    try {
      result = await client.execute({ sql, args: parameters });
    } finally {
      client.close();
    }
    const rows: Array<Record<string, DatabaseValue>> = [];
    let resultBytes = 0;
    let truncated = false;
    for (const row of result.rows) {
      if (rows.length >= DATABASE_LIMITS.rows) {
        truncated = true;
        break;
      }
      const normalized = Object.fromEntries(
        Object.entries(row).map(([key, value]) => {
          const normalized =
            value instanceof ArrayBuffer
              ? base64(value)
              : typeof value === "bigint"
                ? value.toString()
                : value;
          return [key, normalized];
        }),
      ) as Record<string, DatabaseValue>;
      const rowBytes = bytes(JSON.stringify(normalized));
      if (resultBytes + rowBytes > DATABASE_LIMITS.resultBytes) {
        truncated = true;
        break;
      }
      resultBytes += rowBytes;
      rows.push(normalized);
    }
    return {
      columns: result.columns,
      rows,
      rowsAffected: write ? result.rowsAffected : 0,
      truncated,
    };
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const id = body?.id;
    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return rpcError(id, -32600, "Invalid JSON-RPC request");
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    if (body.method === "initialize") {
      const params = body.params as Record<string, unknown> | undefined;
      return jsonRpc(id, {
        protocolVersion:
          typeof params?.protocolVersion === "string"
            ? params.protocolVersion
            : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "opencomputer-database", version: "1.0.0" },
      });
    }
    if (body.method === "ping") return jsonRpc(id, {});
    if (body.method === "tools/list") {
      return jsonRpc(id, {
        tools: [
          {
            name: "query",
            description: "Run one parameterized read-only SQL query against this environment's default database.",
            inputSchema: {
              type: "object",
              properties: {
                sql: { type: "string" },
                parameters: { type: "array", items: { type: ["string", "number", "boolean", "null"] }, default: [] },
              },
              required: ["sql"],
              additionalProperties: false,
            },
          },
          {
            name: "execute",
            description: "Run one parameterized INSERT, UPDATE, DELETE, or REPLACE against this environment's default database.",
            inputSchema: {
              type: "object",
              properties: {
                sql: { type: "string" },
                parameters: { type: "array", items: { type: ["string", "number", "boolean", "null"] }, default: [] },
              },
              required: ["sql"],
              additionalProperties: false,
            },
          },
        ],
      });
    }
    if (body.method !== "tools/call") return rpcError(id, -32601, "Method not found");
    const params = body.params as Record<string, unknown> | undefined;
    const args = params?.arguments as Record<string, unknown> | undefined;
    if (
      (params?.name !== "query" && params?.name !== "execute") ||
      !args ||
      typeof args.sql !== "string"
    ) {
      return rpcError(id, -32602, "Expected query or execute with SQL and optional parameters");
    }
    try {
      const parameters = validateDatabaseParameters(args.parameters ?? []);
      const result =
        params.name === "query"
          ? await this.query(args.sql, parameters)
          : await this.execute(args.sql, parameters);
      return jsonRpc(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      });
    } catch (error) {
      return jsonRpc(id, {
        isError: true,
        content: [
          {
            type: "text",
            text: (error instanceof Error ? error.message : "Database operation failed").slice(0, 500),
          },
        ],
      });
    }
  }
}
