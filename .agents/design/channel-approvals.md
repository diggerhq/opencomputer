# Channel approvals

A human clicks Approve in Slack before an agent's write lands. The click is
answered by the platform, the write runs once, deterministically, from the
arguments the human was shown — not from a second pass through the model.

Slack only, in v1. Buttons are the reason.

## Why: nothing a click sends can reach us

Every agent that touches money or production converges on the same shape.
Autumn's `leaf` is the clearest example in the wild: a Slack billing agent
whose entire product is "no write without a click." It cannot be built on us
today, and neither can anything else in that category.

Two separate reasons, and the second is the real one.

Slack posts interactivity to a URL you configure separately from events, as
`application/x-www-form-urlencoded` carrying a single `payload=` field.
`receiveSlackWebhook` (`blue/src/edge/index.ts:5235`) reads the body with
`JSON.parse` on its third line, so a `block_actions` POST throws before
anything else runs. Past that, `parseSlackEventCallback` returns null for
everything that is not an `event_callback` and we answer `{ok: true}`.

That part is mechanical. The part that isn't: **a session accepts exactly one
kind of input.** `enqueueChannelTurn` (`index.ts:4846`) runs the agent and
delivers what it says. There is no record of a thing the agent proposed and a
human has not yet decided, so there is nowhere for a click to land even once
it arrives. Approvals are a new object, not a new event type.

## The proposal is published, not intercepted

The obvious design is to intercept: let the model call the write tool, catch
the call in the runtime, hold it, and ask. eve does this — `kind:
"tool-approval"` input requests park a turn mid-flight (`parkedInput.ts`).

We should not, for v1.

Interception needs a runtime round-trip we do not have. `permissionMode` is
set once at session config (`internal/api/agent_session.go:66`) and never
answers back. Building that is a change to the agent runtime, the session
protocol, and the suspend/resume path — a turn parked for eight hours is a
session we must keep addressable without keeping a microVM warm.

And it buys less than it looks. Autumn runs both mechanisms, and their
*primary* path is not the parked one. Their gated write records an approval
and returns to the model:

> "Recorded for approval. The user sees an approval card with the exact change
> and applies it from there. Do not call this write again, and do not tell the
> user it has been applied."

The turn then ends normally. Nothing is parked. This is the pattern to build.

So a gated tool publishes a proposal, exactly the way an outbox publishes an
item: the runtime POSTs to the platform with the token it already holds
(`OPENCOMPUTER_OUTBOX_URL` / `_TOKEN`, set in
`blue/src/microvm/supervisor.ts:1138`), and gets back a record id. The
approvals endpoint is the same shape —
`/v1/sessions/<sessionId>/approvals`, same `runtimeToken`.

**This is cooperative, not enforced.** A tool that wants to write anyway can:
`run()` is customer code with its own connections. What the platform
guarantees is narrower and still worth having — that an approved write runs
*once*, from the arguments shown on the card, whether or not the proposing
session still exists. Enforcement would mean the platform holding the
credential and performing the call, which is the managed-egress story pointed
at a different problem, and a separate design.

## The SDK surface

A gated tool splits in two: what the human is shown, and what runs after they
agree.

```ts
export const attach = defineGatedTool({
  name: "attach",
  description: "Move a customer onto a plan.",
  input: {
    type: "object",
    required: ["customerId", "planId"],
    properties: {
      customerId: { type: "string" },
      planId: { type: "string" },
    },
  },
  // What the card says. Pure — no writes, no side effects. It may read.
  async preview({ input, signal }) {
    const customer = await billing.fetch(`/customers/${input.customerId}`, { signal });
    return {
      title: `Move ${customer.name} to ${input.planId}`,
      facts: [
        { label: "Today", value: customer.plan },
        { label: "After", value: input.planId },
        { label: "Charged now", value: "$240.00" },
      ],
    };
  },
  // Runs only after a human approves, from the stored arguments.
  async apply({ input, decision, signal }) {
    return billing.fetch(`/subscriptions`, {
      method: "POST",
      body: JSON.stringify({ customer: input.customerId, plan: input.planId }),
      signal,
    });
  },
});
```

Called by the model, it does not write. It runs `preview`, publishes the
proposal, and returns the "recorded for approval" sentence — the platform
supplies that string so every agent tells the same story and nobody has to
remember to write it.

`apply` runs later, **in a session**, reached by a `tool.apply` frame the
runtime answers with `tool.applied`. Not a turn: the runtime dispatches
straight to the tool rather than to the agent prompt, so no model runs and
nothing can paraphrase the change.

That choice is what makes this cheap. `apply` needs connections, secrets and
managed egress; all three already work inside a session and nowhere else. The
proposing session is used when it is still up, woken when suspended, and
replaced when it is gone — the last of which is the common case, since
decisions arrive hours later and nothing about `apply` depends on the
conversation.

**Nothing waits on it.** The dispatch returns as soon as the frame is away, and
the answer settles the record whenever it arrives. An earlier draft held a
promise open with a 60-second race; that was wrong twice over — it kept a
Durable Object request alive for a minute, and a slow-but-successful write got
reported as a failure. Everything else here that waits is alarm-driven; so is
this.

## The pending-decision record

On the **account** DO, not the session DO. Approvals outlive sessions —
sessions suspend after minutes, approvals sit overnight — for the same reason
`channel_threads` lives there.

```sql
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  session_id TEXT,              -- who proposed it; may be ended by decision time
  turn_id TEXT,
  tool_id TEXT NOT NULL,
  input_json TEXT NOT NULL,     -- the exact arguments. never re-derived
  preview_json TEXT NOT NULL,   -- what the human was shown, kept for the audit trail
  connection_id TEXT NOT NULL,
  delivery_ref TEXT NOT NULL,   -- adapter-opaque, same contract as channel deliveries
  external_message_id TEXT,     -- the card itself, so the decision can edit it
  decider_principal TEXT,       -- who may decide; NULL means anyone on the connection
  status TEXT NOT NULL,         -- pending|approved|denied|applied|failed|expired
  decided_by TEXT,
  decided_at TEXT,
  applied_at TEXT,
  result_json TEXT,
  error TEXT,
  expires_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (agent_id, alias, idempotency_key)
);
CREATE INDEX IF NOT EXISTS approvals_pending ON approvals(status, expires_at);
```

`input_json` is the whole point. The human approved *those* arguments; the
write must use *those* arguments. Asking the agent to proceed would let a
second model pass produce something the card never showed.

There are **two** compare-and-swaps, because there are two moments worth
protecting. `pending → approved|denied` stops a retried or double-clicked
decision from being decided twice. `approved → applying` stops the write itself
from being started twice. Each is a single conditional UPDATE whose `WHERE`
names the state it moves from, and only the caller that wins it goes on.

`applying_at` also gives the sweep something to find: a write in flight is
distinguishable from one never started, which is what lets an unanswered write
be reported honestly rather than guessed at.

`delivery_ref` stays opaque and adapter-owned, exactly as it now does for
replies (`deliveryTarget`, `session-do.ts` — the fix in blue#55). Do not add
`channel_id`/`thread_ts` columns here; that is the mistake we just finished
undoing.

## Where it hooks into blue

**1. A separate interactivity route.**
`/v1/webhooks/slack/<connectionId>/<token>/interactivity`, alongside the
events route (`index.ts:5235`). Separate because Slack configures the two URLs
separately anyway, and because it keeps the form-encoded body away from a
handler whose contract is JSON. Signature verification is already shared and
provider-generic (`account.verifyChannelRequest`) and Slack signs interactivity
with the same HMAC — that part is free.

**2. Two adapter methods.**

```ts
/** A decision on something we proposed. Null for interactions we do not own. */
parseDecision?(body: unknown, headers: Headers): InboundDecision | null;

/** Replace a message we sent — the card, after it has been decided. */
updateMessage?(input: SendInput & { messageId: string }): Promise<void>;
```

`InboundDecision` carries `approvalId`, `choice`, `externalUserId`,
`replyTarget`, `messageId`, and a `scope` for `matchesConnection`, mirroring
`InboundChannelMessage`.

`updateMessage` also fixes something we already owe. Message editing today is
`account.setSlackStatus` (`session-do.ts:2282`) — Slack-specific, called from
outside the adapter seam. That is the same shape as the Twilio number missing
from the Channels tab: a provider-neutral write with a Slack-shaped read still
attached. Moving edits behind the adapter pays that off and gives cards their
lifecycle in one change.

**3. Runtime ingress.** `POST /v1/sessions/<id>/approvals`, authed by
`runtimeToken`, mirroring the outbox endpoint. Body: tool id, input, preview,
idempotency key. It resolves the current turn's channel delivery for
`connection_id` and `delivery_ref`, renders the card, sends it, stores
`external_message_id`.

**4. Decision handling.** Verify, match the connection, load the approval,
check the decider, CAS to `approved`, CAS to `applying`, dispatch the frame,
return. The answer arrives later and settles the record from the account DO —
where the approval's state lives, because the answer can outlive the request
that triggered it. On denial: CAS to `denied`, edit the card, no session.

**6. The sweep.** The account alarm closes out two things: proposals nobody
answered before they expired, and writes that never reported back. The second
settles as **`unknown`**, not `failed` — a write that went quiet may well have
landed, and "Failed to apply" over a real charge is the worse lie. The card
says to check before retrying, and `decision.id` is handed to `apply` as an
idempotency key so that retrying is safe.

**5. Card lifecycle.** After a decision the card must stop being clickable and
say what happened — "Approved by @brian · applied 14:02" — and a stale click on
an already-decided approval must be answered gracefully, because Slack will
send them.

## What the agent learns

The proposing thread should read like a conversation, so a decision posts back
into it as a normal channel turn: *"@brian approved the plan change; it has
been applied."* The agent sees it as ordinary input on the session it already
owns, and can carry on.

That is one line of policy with an outsized effect on how the product feels,
and it is worth getting into v1.

## Not in v1

- **Parked turns.** Covered above. Revisit only if something real needs a
  mid-tool pause, and price the suspend/resume work honestly when we do.
- **Non-Slack cards.** SMS has no buttons; a signed link in an email is a
  plausible v2 and needs its own thinking about link security.
- **Quorum and multi-step chains.** Autumn has `approvalSets` and sibling
  requests; one approver, one decision is enough to learn from.
- **Dashboard surface.** A pending-approvals list is obvious and can wait.

## Settled since this was written

**Who may decide: only the person the proposal was made to.** The
`decider_principal` is the external user whose message the agent was answering,
and a click from anyone else in the thread is ignored. A Slack channel is
visible to everyone in it, and anyone-in-the-conversation would have let a
bystander approve somebody else's write. Revisit if a real workflow needs a
delegate.

**Everything above is built**, on `channels/identity-approvals-apps` in blue and
`channels/identity-and-approvals` in opencomputer3, along with the app-level
routing the multi-workspace case needs. What is not covered by tests is the
shim that acts on a session choice — the choice itself is table-tested through
`selectApplySession`, but dispatching into a real runtime needs a MicroVM the
test harness cannot boot.

## Open questions

**Expiry.** Something like 24h, and expired cards should say so rather than
sit there looking live.

**Preview cost.** `preview` runs during the model's turn and may make network
calls; it needs the same timeout and error handling as any tool, and a failed
preview must fail the proposal rather than produce a card with holes in it.
