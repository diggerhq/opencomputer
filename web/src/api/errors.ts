/** An API failure with the HTTP status and optional typed product reason. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
