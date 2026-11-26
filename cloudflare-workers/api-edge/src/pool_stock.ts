// PoolStock: empty stub kept only so the Durable Object class stays exported.
//
// The edge sandbox pool (pre-reserved hot boxes per cell) is gone with the rest
// of api-edge's sandbox code (097 step 7.2). The class has to stay exported
// because wrangler's migration v2 created it: removing the export without a
// `deleted_classes` migration fails the deploy. We deliberately add no
// migration here, so the class lives on as a no-op. Nothing binds it any more.
//
// Existing instances may still hold an alarm from the old restock loop. When it
// fires, alarm() below does nothing and schedules nothing, so the loop stops.
// Boxes such an instance had reserved are destroyed by the cell's reaper.

export class PoolStock {
  constructor(_state: DurableObjectState, _env: unknown) {}

  async fetch(_req: Request): Promise<Response> {
    return new Response("PoolStock is retired", { status: 410 });
  }

  async alarm(): Promise<void> {}
}
