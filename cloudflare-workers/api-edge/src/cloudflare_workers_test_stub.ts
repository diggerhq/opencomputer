/** Node-only Vitest stand-in for the Workers runtime module. */
export class WorkerEntrypoint<Env> {
  protected readonly ctx: ExecutionContext;
  protected readonly env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
