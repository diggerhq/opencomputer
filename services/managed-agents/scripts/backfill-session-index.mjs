import { readFile } from "node:fs/promises";

const endpoint = process.env.MANAGED_AGENTS_API_URL ?? "https://managedagents.opencomputer.dev";
const secret = process.env.BLUE_SESSION_INDEX_ADMIN_SECRET;
const input = process.argv[2];

if (!secret) throw new Error("BLUE_SESSION_INDEX_ADMIN_SECRET is required");
if (!input) throw new Error("usage: node scripts/backfill-session-index.mjs <org-ids.txt>");

const accountIds = [
  ...new Set(
    (await readFile(input, "utf8"))
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
  ),
];

let indexed = 0;
for (const [position, accountId] of accountIds.entries()) {
  if (!/^[A-Za-z0-9_-]+$/.test(accountId)) {
    throw new Error(`invalid account ID at line ${position + 1}`);
  }
  const url = new URL("/internal/session-index/backfill", endpoint);
  url.searchParams.set("account_id", accountId);
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!response.ok) {
    throw new Error(`backfill failed for ${accountId} (${response.status})`);
  }
  const result = await response.json();
  indexed += result.indexed;
  console.log(`${position + 1}/${accountIds.length} ${accountId}: ${result.indexed}`);
}

console.log(`indexed ${indexed} sessions across ${accountIds.length} organizations`);
