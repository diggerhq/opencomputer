import { createAnthropic } from "@ai-sdk/anthropic";
import {
  cloudConnections,
  cloudSandbox,
  cloudTools,
  createVendo,
  hostedStore,
} from "@vendoai/vendo/server";
import { registry } from "./registry";

type VendoInstance = ReturnType<typeof createVendo>;

interface VendoEnv {
  VENDO_API_KEY?: string;
  VENDO_CLOUD_URL?: string;
  VENDO_BASE_URL?: string;
  VENDO_CLOUD_MODEL?: string;
}

let vendo: VendoInstance | null = null;

function getVendo(env: VendoEnv): VendoInstance {
  if (vendo === null) {
    const fetchImpl: typeof fetch = (input, init) => fetch(input, init);
    const hostBaseUrl = env.VENDO_BASE_URL?.trim();
    const cloudBaseUrl = env.VENDO_CLOUD_URL?.trim();
    const cloudModel = env.VENDO_CLOUD_MODEL?.trim() || "vendo-default";
    const cloud =
      env.VENDO_API_KEY === undefined || env.VENDO_API_KEY.trim() === ""
        ? undefined
        : {
            apiKey: env.VENDO_API_KEY,
            fetch: fetchImpl,
            ...(cloudBaseUrl === undefined || cloudBaseUrl === "" ? {} : { baseUrl: cloudBaseUrl }),
          };

    const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    if (hostBaseUrl !== undefined && hostBaseUrl !== "" && processEnv !== undefined) {
      processEnv.VENDO_BASE_URL = hostBaseUrl;
    }

    vendo = createVendo({
      principal: async () => null,
      catalog: registry,
      policy: {},
      ...(cloud === undefined
        ? {}
        : {
            model: createAnthropic({
              apiKey: cloud.apiKey,
              baseURL: `${(cloud.baseUrl ?? "https://console.vendo.run").replace(/\/+$/, "")}/api/v1`,
              fetch: fetchImpl,
            })(cloudModel),
            store: hostedStore(cloud),
            connections: cloudConnections(cloud),
            connectors: [cloudTools(cloud)],
            sandbox: cloudSandbox(cloud),
          }),
    });
  }
  return vendo;
}

export function handleVendoRequest(request: Request, env: VendoEnv): Promise<Response> {
  return getVendo(env).handler(request);
}
