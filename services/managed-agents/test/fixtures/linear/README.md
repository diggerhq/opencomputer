# Linear playback fixtures

`spike-playback.json` is the provider spike's recorded traffic (work 037,
build record "Provider spike", parts 1–7), in order: every
`AgentSessionEvent` delivery Linear sent the spike receiver (`kind:
"delivery"`, headers and body) and every `agentActivityCreate` the receiver
made with Linear's response (`kind: "activity_create"`).

Timestamps, headers and enum values are as recorded, so ordering and
timing relations (a prompt's `createdAt` against an elicitation's, `sentAt`
on released held messages, the stop's provider time) are real. People and
content are not: names, emails, profile URLs, issue titles, descriptions,
prompt context, comments and message bodies are replaced with fixture
values, and every Linear id (organization, team, issue, user, session,
activity, webhook, OAuth client) is replaced with a deterministic fake
(`00000000-0000-4000-8000-…`, numbered by first appearance) consistently
across the fixture and the tests that name them; bodies that are option values or control words (`go`, `plan`,
`held`, `stop`, …) are kept because tests match on them. The recorded
`linear-signature` was computed over the original body; tests re-sign each
body with their own secret.

The payload's `agentSession.status` is recorded as Linear sent it and must
not be read (work 037: Linear's session status is noise).
