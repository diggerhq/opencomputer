// What a shell actor answers: a class that exists for its migration and does nothing yet.

export function unavailable(actor: string): Response {
  return Response.json(
    { error: { code: "unavailable", message: `${actor} is not available yet.`, retryable: true } },
    { status: 503, headers: { "retry-after": "5" } },
  );
}
