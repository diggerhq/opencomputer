/** What one create call returned, however it was actually sent. */
export interface CreateCallResult {
  status: number;
  /** The CP's response body, verbatim for a single create. */
  text: string;
  /** True when this create shared a request with others. */
  batched: boolean;
  /** How many creates shared that request (1 when sent alone). */
  batchSize: number;
  /** Time this create spent waiting to be dispatched, in ms. */
  waitMs: number;
}
