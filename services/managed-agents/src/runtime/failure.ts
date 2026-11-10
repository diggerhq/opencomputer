/** Normalize the provider's credit preflight refusal at the runtime boundary. */
export function failedTurnData(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const creditExhausted =
    message.includes("requires more credits, or fewer max_tokens") &&
    message.includes("can only afford");
  return {
    message,
    ...(creditExhausted ? { code: "model_credit_exhausted" } : {}),
  };
}
