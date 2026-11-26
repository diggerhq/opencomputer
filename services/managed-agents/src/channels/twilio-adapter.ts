import {
  boundedRequest,
  bytesToHex,
  constantTimeEqual,
  hmac,
  ProviderRequestError,
  retryAfterHeaderMs,
  type ChannelAdapter,
  type InboundChannelMessage,
  type VerifyInput,
} from "./adapter.js";

/**
 * Named for the vendor, as Slack's adapter is. What this handles is Twilio's
 * wire format, not "SMS" — a different SMS vendor signs and shapes differently
 * and would be its own adapter.
 *
 * Twilio WhatsApp rides the same Messages API, webhook, and signature, with a
 * `whatsapp:` prefix on addresses, so it needs no separate adapter.
 *
 * Two things differ from Slack in ways the seam has to absorb:
 *
 * - The body is form-encoded, not JSON, and the signature covers the request
 *   URL concatenated with the sorted parameters rather than the raw body.
 * - There is no thread. A conversation is the pair of numbers, so the
 *   participant's number is the conversation key.
 */
function formParameters(payload: string): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const [name, value] of new URLSearchParams(payload)) {
    parameters[name] = value;
  }
  return parameters;
}

/** The URL as given, and the same URL under the other scheme. */
function schemeVariants(url: string): string[] {
  if (url.startsWith("https://")) return [url, `http://${url.slice(8)}`];
  if (url.startsWith("http://")) return [url, `https://${url.slice(7)}`];
  return [url];
}

export const twilioAdapter: ChannelAdapter = {
  provider: "twilio",

  // A text is final once delivered, so there is no status message to edit.
  // Progress has to be silent rather than a stream of interim texts.
  editableProgress: false,

  // A text has no buttons: a question is the turn's text reply and keeps
  // today's semantics, holding other messages until it is answered.
  questionMode: "hold",

  // Twilio accepts up to 1600 characters in one request and segments them; a
  // longer body is rejected outright, so the reply is trimmed to fit.
  maxMessageLength: 1600,

  async verify({ payload, headers, url, secret }: VerifyInput) {
    const signature = headers.get("x-twilio-signature");
    if (!signature) return false;
    const parameters = formParameters(payload);
    // Twilio signs the full URL followed by each parameter name and value in
    // key order, concatenated with no separator.
    const tail = Object.keys(parameters)
      .sort()
      .map((name) => `${name}${parameters[name]}`)
      .join("");
    // Twilio sends base64; compare hex on both sides so the comparison stays
    // constant-time over a single alphabet.
    let received: string;
    try {
      received = bytesToHex(
        Uint8Array.from(atob(signature), (character) => character.charCodeAt(0)),
      );
    } catch {
      return false;
    }
    // Because the signature covers a URL rather than the body, it breaks
    // whenever anything between Twilio and here disagrees about the scheme —
    // a TLS-terminating proxy, a tunnel that upgrades the connection. Twilio
    // signs what it finally reached; the Worker reconstructs what it received.
    // Both spellings are checked, which costs an HMAC and gives away nothing:
    // forging either still needs the auth token.
    for (const candidate of schemeVariants(url)) {
      const digest = await hmac("SHA-1", secret, candidate + tail);
      if (constantTimeEqual(received, bytesToHex(digest))) return true;
    }
    return false;
  },

  parseInbound(payload): InboundChannelMessage | null {
    if (typeof payload !== "string") return null;
    const parameters = formParameters(payload);
    const from = parameters.From;
    const to = parameters.To;
    const sid = parameters.MessageSid ?? parameters.SmsSid;
    if (!from || !to || !sid) return null;
    // Status callbacks reuse the same endpoint and carry no body.
    if (parameters.Body === undefined) return null;
    return {
      id: sid,
      externalUserId: from,
      // No threads over SMS: the participant is the conversation.
      conversationKey: from,
      // The Twilio account is the tenant; the number is where it landed.
      ...(parameters.AccountSid ? { workspaceId: parameters.AccountSid } : {}),
      conversationId: to,
      // The reply reverses the delivery: out from our number, back to theirs.
      replyTarget: { to: from, from: to },
      text: parameters.Body,
      scope: { accountSid: parameters.AccountSid, to },
      data: parameters,
    };
  },

  async send({ target, text, credential }) {
    const accountSid = credential.accountSid;
    const authToken = credential.authToken;
    if (typeof accountSid !== "string" || typeof authToken !== "string") {
      throw new Error("Twilio connection has no account SID or auth token");
    }
    const to = target.to;
    const from = target.from;
    if (typeof to !== "string" || typeof from !== "string") {
      throw new Error("Twilio reply is missing a to or from number");
    }
    const body = text.length > 1600 ? `${text.slice(0, 1597)}...` : text;
    await boundedRequest(
      "Twilio message",
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
      },
      async (response, signal) => {
        if (response.ok) return;
        const detail = await response.text().catch((error: unknown) => {
          if (signal.aborted) throw error;
          return "";
        });
        throw new ProviderRequestError(
          `Twilio rejected the message (${String(response.status)}): ${detail.slice(0, 200)}`,
          response.status === 429 ? retryAfterHeaderMs(response) : undefined,
        );
      },
    );
  },

  matchesConnection(message, connection) {
    if (connection.status !== "connected") return false;
    if (
      typeof connection.accountSid === "string" &&
      connection.accountSid !== message.scope.accountSid
    ) {
      return false;
    }
    // The number the customer texted must be the one this connection owns,
    // otherwise another tenant's delivery would land here.
    return (
      typeof connection.from === "string" && connection.from === message.scope.to
    );
  },
};
