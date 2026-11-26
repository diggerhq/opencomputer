// POST /v1/computer/agent/connect: the CLI's login with a connect code the dashboard minted.

import type { ComputerEdgeEnv } from "../../actors/computer/config.js";
import { isHarness } from "../../actors/computer/held-for-org/model-access/harnesses.js";
import { CONNECT_CODE_INVALID, connectCodeHash, connectCodeIndexName, logConnectCode, normalizeConnectCode } from "../../actors/connect-codes/codes.js";
import { json, problem } from "../../edge/http.js";
import { isPoolId } from "../../ids/computer-names.js";
import { agentBody, CODEX_BODY_MAX_BYTES } from "../agent-body.js";
import { computerOf, computers, reservedName } from "../computer-objects.js";

/**
 * POST /v1/computer/agent/connect (work 082, CLI connect): the CLI's login,
 * with the connect code the dashboard minted, stored as the dashboard's PUT
 * /agent/claude or /agent/codex would for the code's person. Every bad code
 * is the same 401, and so is a harness this computer can't run (the
 * authenticated routes' 409 would say which codes are live); the connect's
 * other refusals pass through. The answer says nothing about the person.
 * Neither the code nor the login is logged.
 */
export async function connectWithCode(request: Request, env: ComputerEdgeEnv): Promise<Response> {
  const input = await agentBody(request, CODEX_BODY_MAX_BYTES);
  if (input instanceof Response) return input;
  const provider = input.provider;
  if (typeof input.code !== "string" || !isHarness(provider)) {
    return problem(400, "invalid_request", "code and provider (claude or codex) are required");
  }
  const invalid = () => problem(CONNECT_CODE_INVALID.status, CONNECT_CODE_INVALID.code, CONNECT_CODE_INVALID.message);
  const code = normalizeConnectCode(input.code);
  if (!code) {
    logConnectCode({ action: "refused", reason: "malformed", provider });
    return invalid();
  }
  const hash = await connectCodeHash(code);
  const accountId = await computers(env).getByName(connectCodeIndexName(hash)).connectCodeAccount(hash);
  if (!accountId || reservedName(accountId) || isPoolId(accountId)) {
    logConnectCode({ action: "refused", reason: "unknown", provider });
    return invalid();
  }
  const authJson = input.authJson && typeof input.authJson === "object" ? JSON.stringify(input.authJson) : input.authJson;
  const result = await computerOf(env, accountId).agentConnectWithCode(accountId, code, {
    provider,
    ...(provider === "claude" ? { token: input.token } : { authJson }),
  });
  if (!result.ok) return problem(result.status, result.code, result.message);
  return json({ provider: result.provider, connected: true });
}
