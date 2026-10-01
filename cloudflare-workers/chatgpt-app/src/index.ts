import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { handleDefault } from "./authorize.js";
import { SCOPE, type Env, type GrantProps } from "./env.js";
import { agentsClient } from "./opencomputer.js";
import { createMcpServer } from "./tools.js";

const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: GrantProps }).props;
    if (!props?.apiKey) return new Response("Unauthorized", { status: 401 });
    const server = createMcpServer(agentsClient(env, props.apiKey));
    // Stateless: every request builds its server from the grant, so any isolate can answer it.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(publicUrl: string): OAuthProvider<Env> {
  const origin = new URL(publicUrl).origin;
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler,
      defaultHandler: { fetch: (request, env) => handleDefault(request as Request, env) },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE, "offline_access"],
      requiredScopes: [SCOPE],
      accessTokenTTL: 3600,
      refreshTokenTTL: 90 * 24 * 3600,
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(env.PUBLIC_URL).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
