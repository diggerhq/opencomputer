/**
 * The rehearsal's operator routes (rehearsal.ts), all POST with `Authorization: Bearer $REHEARSAL_KEY` and
 * `?account_id=`: `/internal/computer/rehearsal/dump` {table, offset}, `load` {table, rows}, `migrate`.
 * 503 without `REHEARSAL_KEY` on the Worker; `load` and `migrate` are 403 in production.
 */
import type { ComputerDurableObject } from "./durable-object.js";
import { isRehearsalTable, type RehearsalRow } from "./rehearsal.js";

interface RehearsalEnv {
  REHEARSAL_KEY?: string;
  BLUE_ENVIRONMENT?: string;
  COMPUTERS?: unknown;
}

const answer = (status: number, body: unknown): Response => Response.json(body, { status });

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function rehearsalResponse(request: Request, env: RehearsalEnv, url: URL): Promise<Response> {
  if (request.method !== "POST") return answer(405, { error: "method_not_allowed" });
  if (!env.REHEARSAL_KEY) return answer(503, { error: "not_configured" });
  const given = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  // Compared as digests, so the comparison's time says nothing about the key.
  if (!given || (await digest(given)) !== (await digest(env.REHEARSAL_KEY))) return answer(401, { error: "unauthorized" });
  const accountId = url.searchParams.get("account_id") ?? "";
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(accountId)) return answer(400, { error: "invalid_account_id" });
  const namespace = env.COMPUTERS as DurableObjectNamespace<ComputerDurableObject> | undefined;
  if (!namespace) return answer(503, { error: "not_configured" });
  const computer = namespace.getByName(accountId);
  const action = url.pathname.slice("/internal/computer/rehearsal/".length);
  const body = (await request.json().catch(() => ({}))) as { table?: unknown; offset?: unknown; rows?: unknown };
  if (action === "dump") {
    if (!isRehearsalTable(body.table)) return answer(400, { error: "invalid_table" });
    const page = await computer.rehearsalDump(accountId, body.table, Number(body.offset) || 0, 500);
    return page ? answer(200, page) : answer(404, { error: "no_computer" });
  }
  if (env.BLUE_ENVIRONMENT === "production") return answer(403, { error: "not_in_production" });
  if (action === "load") {
    if (!isRehearsalTable(body.table) || !Array.isArray(body.rows)) return answer(400, { error: "invalid_table_or_rows" });
    return answer(200, { written: await computer.rehearsalLoad(accountId, body.table, body.rows as RehearsalRow[]) });
  }
  if (action === "migrate") return answer(200, await computer.rehearsalMigrate(accountId));
  return answer(404, { error: "not_found" });
}
