const ts = () => new Date().toISOString().slice(11, 23);
export const log = {
  info: (...a: unknown[]) => console.log(ts(), ...a),
  warn: (...a: unknown[]) => console.warn(ts(), 'WARN', ...a),
  error: (...a: unknown[]) => console.error(ts(), 'ERROR', ...a),
};

/** What went wrong, for logs and replies: a Slack API error code, else the message. */
export function errorText(e: unknown): string {
  const x = e as { data?: { error?: string }; message?: string } | undefined;
  return x?.data?.error ?? x?.message ?? String(e);
}
