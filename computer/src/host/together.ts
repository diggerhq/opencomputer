// Start steps that do not depend on each other, run at the same time (a
// claim's directories, mint and pid; a start's directories and inventory).
//
// Invariant: `together` settles only once every step has, so that nothing a
// failed start began is still running when its failure is handled (a Create
// that lands after its start was abandoned); it then rejects with the first
// rejection in the order given, else resolves with every result in that order.

export async function together<T extends readonly unknown[]>(steps: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const settled = await Promise.allSettled(steps);
  for (const s of settled) if (s.status === 'rejected') throw s.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/** `step`, its time in ms put in `data` under `field` once it resolved. */
export async function timed<T>(data: Record<string, unknown>, field: string, step: Promise<T>): Promise<T> {
  const t0 = Date.now();
  const v = await step;
  data[field] = Date.now() - t0;
  return v;
}
