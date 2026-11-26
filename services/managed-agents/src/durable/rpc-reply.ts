// What an actor's RPC method answers: a value, or a refusal in place of throwing.

/** A refusal an actor answers in place of throwing; the edge turns it into the HTTP error of spec 34.2. */
export type Refusal = { ok: false; code: string; status?: number; reason?: string; message?: string; [field: string]: unknown };
export type Reply<T> = ({ ok: true } & T) | Refusal;
