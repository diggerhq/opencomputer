import { defineOperation, definePlugin, schema } from "@opencomputer/cli/plugin";

const draft = defineOperation({
  description: "Create a Gmail draft after review of its complete contents.",
  input: schema.object({
    to: schema.array(schema.string().email()).min(1),
    cc: schema.array(schema.string().email()).default([]),
    bcc: schema.array(schema.string().email()).default([]),
    subject: schema
      .string()
      .max(998)
      .refine((value) => !/[\r\n]/.test(value), "Subject cannot contain newlines"),
    body: schema.string().max(1_000_000),
  }),
  output: schema.object({
    id: schema.string(),
    threadId: schema.string().optional(),
  }),
  execution: "broker",
  effects: ["external.write"],
  connection: "gmail",
  network: ["https://gmail.googleapis.com"],
  limits: { timeoutMs: 30_000, maxOutputBytes: 16_384 },
  async execute(input, context) {
    const header = (name: string, values: string[]) =>
      values.length ? [`${name}: ${values.join(", ")}`] : [];
    const message = [
      ...header("To", input.to),
      ...header("Cc", input.cc),
      ...header("Bcc", input.bcc),
      `Subject: ${input.subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      input.body,
    ].join("\r\n");
    const response = await context.fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: { raw: Buffer.from(message).toString("base64url") },
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Gmail draft creation failed (${response.status})`);
    }
    const result = (await response.json()) as {
      id: string;
      message?: { threadId?: string };
    };
    return {
      id: result.id,
      ...(result.message?.threadId ? { threadId: result.message.threadId } : {}),
    };
  },
});

export function googlePlugin(options?: { operations?: readonly string[] }) {
  const selected = new Set(options?.operations ?? ["gmail.drafts.create"]);
  return definePlugin({
    name: "google",
    packageName: "@opencomputer/plugin-google",
    displayName: "Google",
    description: "Scoped Google service operations.",
    operations: Object.fromEntries(
      Object.entries({ "gmail.drafts.create": draft }).filter(([name]) =>
        selected.has(name),
      ),
    ),
  });
}
