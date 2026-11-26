export interface TemplateTaskApiConfiguration {
  baseUrl: string;
  secret: string;
}

export async function templateTaskRequest<T>(
  configuration: TemplateTaskApiConfiguration,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(
    new URL(path, `${configuration.baseUrl.replace(/\/+$/, "")}/`),
    {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-opencomputer-template-task-secret": configuration.secret,
        ...Object.fromEntries(new Headers(init.headers)),
      },
      redirect: "manual",
    },
  );
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const record =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    throw new Error(
      typeof record.message === "string"
        ? record.message
        : `Template task API failed (${response.status})`,
    );
  }
  return body as T;
}
