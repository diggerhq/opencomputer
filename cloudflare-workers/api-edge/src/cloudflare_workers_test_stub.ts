/** Node-only Vitest stand-in for the Workers runtime module. */
export class WorkerEntrypoint<Env> {
  protected readonly env: Env;

  constructor(_ctx: unknown, env: Env) {
    this.env = env;
  }
}
