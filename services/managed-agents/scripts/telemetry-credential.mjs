#!/usr/bin/env node
// Telemetry credentials for computers' hosts (work 054,
// "Host credentials"; src/computer/telemetry/credential.ts).
//
//   npm run telemetry-credential -- keygen
//       A new key pair: TELEMETRY_SIGNING_KEY (the edge Worker's secret) and
//       CREDENTIAL_PUBLIC_KEY (Calvin's telemetry collector's).
//   TELEMETRY_SIGNING_KEY=… npm run telemetry-credential -- issue --org <organization id> --host <SP_HOST_ID>
//       A 90-day credential for that host's host.env (SP_TELEMETRY_CREDENTIAL).
//       Connected hosts also get a fresh one in every `welcome`.
//
// Prints secrets to stdout; pipe them where they go, never into a file in Git.
import { parseArgs } from "node:util";
import { generateTelemetryKeys, issueTelemetryCredential } from "../src/computer/telemetry/credential.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { org: { type: "string" }, host: { type: "string" } },
});

if (positionals[0] === "keygen") {
  const { signingKey, publicKey } = await generateTelemetryKeys();
  console.log(`TELEMETRY_SIGNING_KEY=${signingKey}`);
  console.log(`CREDENTIAL_PUBLIC_KEY=${publicKey}`);
} else if (positionals[0] === "issue" && values.org && values.host) {
  const key = process.env.TELEMETRY_SIGNING_KEY;
  if (!key) {
    console.error("TELEMETRY_SIGNING_KEY is not set");
    process.exit(2);
  }
  console.log(`SP_TELEMETRY_CREDENTIAL=${await issueTelemetryCredential(key, { orgId: values.org, hostId: values.host })}`);
} else {
  console.error("usage: telemetry-credential keygen | issue --org <organization id> --host <host id>");
  process.exit(2);
}
