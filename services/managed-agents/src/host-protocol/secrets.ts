// The secrets a runner gets, and a session's request for one.

export type SecretScope = "session" | "user" | "workspace";

/** What a runner gets: an environment variable, or a file whose path is in the variable. */
export interface SessionSecret {
  name: string;
  value: string;
  scope: SecretScope;
  file?: boolean;
  /** A variable (`!var`): not secret, so the runner never redacts it. Older runners redact it like a secret. */
  variable?: boolean;
}

/** A session's request_secret: the gateway posts a button in its thread. */
export interface SecretRequest {
  name: string;
  reason: string;
  file?: boolean;
}
