import type {
  DeploymentCapabilities,
  DeploymentReadinessReceipt,
  OpenComputerClient,
} from "./api.js";
import { CLIError } from "./errors.js";

// `opencomputer deployments ...` (docs/agents/deployments.mdx): the
// capability manifest and readiness receipt of one deployment.

export const DEPLOYMENTS_USAGE =
  "Usage:\n" +
  "  opencomputer deployments capabilities <deployment-id> [--digest sha256:...] [--json]\n" +
  "  opencomputer deployments readiness <deployment-id> [--json]";

function takeDigestOption(args: string[]): string | undefined {
  const equalsIndex = args.findIndex((argument) => argument.startsWith("--digest="));
  if (equalsIndex >= 0) {
    const value = args[equalsIndex]!.slice("--digest=".length);
    if (!value) throw new Error("--digest requires a value");
    args.splice(equalsIndex, 1);
    return value;
  }
  const index = args.indexOf("--digest");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--digest requires a value");
  args.splice(index, 2);
  return value;
}

function list(label: string, values: string[]): string {
  return `  ${label.padEnd(13)}${values.length ? values.join(", ") : "—"}\n`;
}

export function formatCapabilities(result: DeploymentCapabilities): string {
  const { manifest } = result;
  return (
    `Deployment    ${manifest.deploymentId}\n` +
    `Agent         ${manifest.agentId}${manifest.alias ? ` (${manifest.alias})` : ""}\n` +
    `Manifest      ${result.manifestDigest}\n` +
    `Source        ${manifest.sourceDigest}\n` +
    `Runtime image ${manifest.runtimeImageDigest}${manifest.runtimeMode ? ` (${manifest.runtimeMode})` : ""}\n` +
    `Created       ${manifest.createdAt}\n` +
    list(
      "Models",
      manifest.models.map((model) => `${model.provider}/${model.model}`),
    ) +
    list(
      "Tools",
      manifest.tools.map((tool) => (tool.gated ? `${tool.id} (gated)` : tool.id)),
    ) +
    list(
      "Results",
      manifest.resultSchemas.map((schema) => schema.toolId),
    ) +
    list(
      "Skills",
      manifest.skills.map((skill) => skill.name),
    ) +
    list(
      "MCP servers",
      manifest.mcpServers.map((server) =>
        server.origin ? `${server.id} (${server.origin})` : server.id,
      ),
    ) +
    list(
      "Connections",
      manifest.connections.map((connection) => `${connection.id} (${connection.kind})`),
    ) +
    list(
      "Memory",
      manifest.memory.map((resource) => resource.id),
    ) +
    list(
      "Regions",
      manifest.regions.map((region) => `${region.scope}=${region.region}`),
    )
  );
}

export function formatReadiness(receipt: DeploymentReadinessReceipt): string {
  const lines = receipt.checks.map((check) => {
    const status =
      check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "SKIP";
    const required = check.required ? "" : " (optional)";
    return `  ${status} ${check.id.padEnd(18)} ${check.summary}${required}\n`;
  });
  return (
    `Deployment    ${receipt.deploymentId}\n` +
    `Environment   ${receipt.environment}\n` +
    `Manifest      ${receipt.manifestDigest}\n` +
    `Checked       ${receipt.checkedAt}\n` +
    `Ready         ${receipt.ready ? "yes" : "no"}\n` +
    lines.join("")
  );
}

export async function runDeploymentsCommand(
  client: OpenComputerClient,
  args: string[],
  json: boolean,
): Promise<void> {
  const action = args.shift();
  const digest = action === "capabilities" ? takeDigestOption(args) : undefined;
  const deploymentId = args.shift();
  if (!action || !deploymentId) throw new Error(DEPLOYMENTS_USAGE);
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
  if (action === "capabilities") {
    const result = await client.deploymentCapabilities(deploymentId, digest);
    process.stdout.write(
      json ? `${JSON.stringify(result, null, 2)}\n` : formatCapabilities(result),
    );
    return;
  }
  if (action === "readiness") {
    const receipt = await client.deploymentReadiness(deploymentId);
    process.stdout.write(
      json ? `${JSON.stringify(receipt, null, 2)}\n` : formatReadiness(receipt),
    );
    if (!receipt.ready) {
      throw new CLIError(
        "deployment_not_ready",
        "A required readiness check failed.",
        "Inspect the failed checks above (or in `--json` output) and fix the configuration they name.",
        json ? undefined : receipt.checks.filter((check) => check.status === "fail"),
      );
    }
    return;
  }
  throw new Error(DEPLOYMENTS_USAGE);
}
