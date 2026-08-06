import { defineOperation, definePlugin, schema } from "@opencomputer/cli/plugin";

const repositoryInput = schema.object({
  repository: schema.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  ref: schema.string().min(1).max(255).optional(),
});

const inspect = defineOperation({
  description: "Inspect bounded GitHub repository metadata, README, and root tree.",
  input: repositoryInput,
  output: schema.object({
    repository: schema.string(),
    private: schema.boolean(),
    defaultBranch: schema.string(),
    resolvedCommit: schema.string(),
    description: schema.string().nullable(),
    readme: schema.string().max(262_144).optional(),
    tree: schema.array(schema.object({ path: schema.string(), type: schema.string() })).max(500),
  }),
  execution: "broker",
  effects: ["external.read"],
  connection: "github",
  network: ["https://api.github.com"],
  limits: { timeoutMs: 30_000, maxOutputBytes: 524_288 },
  async execute(input, context) {
    const headers = { accept: "application/vnd.github+json" };
    const repository = await context.fetch(
      `https://api.github.com/repos/${input.repository}`,
      { headers },
    );
    if (!repository.ok) {
      throw new Error(`GitHub repository lookup failed (${repository.status})`);
    }
    const metadata = (await repository.json()) as {
      private: boolean;
      default_branch: string;
      description: string | null;
    };
    const ref = encodeURIComponent(input.ref ?? metadata.default_branch);
    const commitResponse = await context.fetch(
      `https://api.github.com/repos/${input.repository}/commits/${ref}`,
      { headers },
    );
    if (!commitResponse.ok) {
      throw new Error(`GitHub ref lookup failed (${commitResponse.status})`);
    }
    const commit = (await commitResponse.json()) as { sha: string };
    const treeResponse = await context.fetch(
      `https://api.github.com/repos/${input.repository}/git/trees/${commit.sha}`,
      { headers },
    );
    if (!treeResponse.ok) {
      throw new Error(`GitHub tree lookup failed (${treeResponse.status})`);
    }
    const treeResult = (await treeResponse.json()) as {
      tree?: Array<{ path: string; type: string }>;
    };
    const readmeResponse = await context.fetch(
      `https://api.github.com/repos/${input.repository}/readme?ref=${ref}`,
      { headers: { accept: "application/vnd.github.raw+json" } },
    );
    const readme = readmeResponse.ok
      ? (await readmeResponse.text()).slice(0, 262_144)
      : undefined;
    return {
      repository: input.repository,
      private: metadata.private,
      defaultBranch: metadata.default_branch,
      resolvedCommit: commit.sha,
      description: metadata.description,
      ...(readme ? { readme } : {}),
      tree: (treeResult.tree ?? [])
        .slice(0, 500)
        .map(({ path, type }) => ({ path, type })),
    };
  },
});

const checkout = defineOperation({
  description: "Materialize an authorized GitHub repository into a new workspace directory.",
  input: repositoryInput.extend({
    destination: schema
      .string()
      .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/),
  }),
  output: schema.object({
    destination: schema.string(),
    resolvedCommit: schema.string(),
    artifact: schema.object({
      id: schema.string(),
      mediaType: schema.string(),
      size: schema.number(),
      sha256: schema.string(),
    }),
  }),
  execution: "hybrid",
  effects: ["external.read", "workspace.create"],
  connection: "github",
  network: ["https://api.github.com"],
  workspaceAdapter: "git.checkout",
  limits: { timeoutMs: 120_000, maxArtifactBytes: 104_857_600 },
  async execute(input, context) {
    const requestedRef = encodeURIComponent(input.ref ?? "HEAD");
    const commitResponse = await context.fetch(
      `https://api.github.com/repos/${input.repository}/commits/${requestedRef}`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (!commitResponse.ok) {
      throw new Error(`GitHub ref lookup failed (${commitResponse.status})`);
    }
    const { sha } = (await commitResponse.json()) as { sha: string };
    const response = await context.fetch(
      `https://api.github.com/repos/${input.repository}/tarball/${sha}`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (!response.ok) {
      throw new Error(`GitHub checkout fetch failed (${response.status})`);
    }
    const artifact = await context.artifact({
      body: new Uint8Array(await response.arrayBuffer()),
      mediaType: "application/gzip",
    });
    return { destination: input.destination, resolvedCommit: sha, artifact };
  },
});

export function githubPlugin(options?: { operations?: readonly string[] }) {
  const selected = new Set(
    options?.operations ?? ["repository.inspect", "repository.checkout"],
  );
  return definePlugin({
    name: "github",
    packageName: "@opencomputer/plugin-github",
    displayName: "GitHub",
    description: "Scoped GitHub repository operations.",
    operations: Object.fromEntries(
      Object.entries({
        "repository.inspect": inspect,
        "repository.checkout": checkout,
      }).filter(([name]) => selected.has(name)),
    ),
  });
}
