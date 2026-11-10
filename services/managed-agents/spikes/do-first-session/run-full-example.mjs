const baseUrl = process.env.DO_FIRST_SPIKE_URL?.replace(/\/$/, "");
const apiKey = process.env.DO_FIRST_SPIKE_API_KEY;
const agentId = process.env.DO_FIRST_SPIKE_AGENT;

if (!baseUrl || !apiKey || !agentId) {
  throw new Error(
    "DO_FIRST_SPIKE_URL, DO_FIRST_SPIKE_API_KEY, and DO_FIRST_SPIKE_AGENT are required",
  );
}

const startedAt = performance.now();
const headers = {
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
};
const createdResponse = await fetch(`${baseUrl}/v1/sessions`, {
  method: "POST",
  headers,
  body: JSON.stringify({ agentId }),
});
if (!createdResponse.ok) {
  throw new Error(
    `Session creation failed (${createdResponse.status}): ${await createdResponse.text()}`,
  );
}
const created = await createdResponse.json();
console.log(
  JSON.stringify({
    phase: "session_created",
    elapsedMs: Math.round(performance.now() - startedAt),
    sessionId: created.session.id,
    deploymentId: created.deployment?.id,
    artifactDigest: created.deployment?.artifact?.digest,
    runtimeStarted: Boolean(created.session.microvmId),
  }),
);

const socketUrl = new URL(
  `/v1/sessions/${encodeURIComponent(created.session.id)}/connect`,
  baseUrl,
);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
socketUrl.searchParams.set("role", "client");
socketUrl.searchParams.set("cursor", "0");
socketUrl.searchParams.set("api_key", apiKey);

const socket = new WebSocket(socketUrl);
const timeout = setTimeout(() => {
  socket.close();
  throw new Error("The example did not complete within two minutes");
}, 120_000);

socket.addEventListener("message", (message) => {
  const frame = JSON.parse(String(message.data));
  if (frame.type !== "event") return;
  const event = frame.event;
  console.log(
    JSON.stringify({
      phase: "event",
      elapsedMs: Math.round(performance.now() - startedAt),
      seq: event.seq,
      type: event.type,
      data: event.data,
    }),
  );
  if (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "session.failed"
  ) {
    clearTimeout(timeout);
    socket.close();
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
console.log(
  JSON.stringify({
    phase: "stream_connected",
    elapsedMs: Math.round(performance.now() - startedAt),
  }),
);

const turnResponse = await fetch(
  `${baseUrl}/v1/sessions/${encodeURIComponent(created.session.id)}/turns`,
  {
    method: "POST",
    headers,
    body: JSON.stringify({
      input:
        "Read the repository configuration, identify the package scripts, and summarize how to run its tests.",
      idempotencyKey: crypto.randomUUID(),
    }),
  },
);
if (!turnResponse.ok) {
  clearTimeout(timeout);
  socket.close();
  throw new Error(
    `Turn creation failed (${turnResponse.status}): ${await turnResponse.text()}`,
  );
}
console.log(
  JSON.stringify({
    phase: "turn_accepted",
    elapsedMs: Math.round(performance.now() - startedAt),
    ...(await turnResponse.json()),
  }),
);

await new Promise((resolve) => {
  socket.addEventListener("close", resolve, { once: true });
});
