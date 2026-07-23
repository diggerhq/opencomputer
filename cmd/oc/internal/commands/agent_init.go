package commands

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"
)

const agentTomlTmpl = `name  = %q
model = %q

[runtime]
family = %q   # claude | codex | pi | flue | langgraph
type   = "default"

[limits]
turns = 24
`

const promptTmpl = `You are a helpful agent.

Describe the agent's behavior here — this file is the system prompt.
`

const skillTmpl = `---
name: example
description: An example skill. Rename or delete this folder.
---

# Example skill

Describe what this skill does and when to use it. Delete the skills/ directory
entirely if your agent doesn't need skills.
`

// ── LangGraph (JS) runtime scaffold ──────────────────────────────────────────
// A code runtime (not prompt-based): the agent IS a compiled LangGraph.js graph.
// The scaffold is self-contained and runs locally (npm i && npm run dev); the
// OpenComputer `langgraph` runner drives the exported `graph` per session.

const lgPackageJSON = `{
  "name": %q,
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.19.0 <23" },
  "scripts": {
    "dev": "tsx src/graph.ts",
    "typecheck": "tsc --noEmit",
    "deploy": "oc agent deploy"
  },
  "dependencies": {
    "@opencomputer/langgraph": "^0.0.1",
    "@langchain/langgraph": "^1.4.8",
    "@langchain/langgraph-checkpoint": "^1.0.0",
    "@langchain/anthropic": "^1.5.1",
    "@langchain/core": "^1.2.3"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.20.0",
    "typescript": "^5.9.3",
    "wrangler": "^4.0.0"
  }
}
`

const lgTsconfig = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "types": ["node"]
  },
  "include": ["src"]
}
`

const lgGitignore = `node_modules/
dist/
.env
.env.*
*.log
.DS_Store
`

// src/graph.ts — the StateGraph. THIS is where you author your agent.
const lgGraphTs = `import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { ocModel } from "@opencomputer/langgraph";

// THIS is where you author your agent. Nodes call models via ocModel(env): env is
// config.configurable.env on deploy (carries the gateway token) and process.env
// locally. Keep 'compile' exported so the runtime injects the durable per-session
// Durable Object checkpointer.
const builder = new StateGraph(MessagesAnnotation)
  .addNode("agent", async (state, config) => {
    const env = (config?.configurable?.env as Record<string, string | undefined>) ?? process.env;
    const res = await ocModel(env).invoke(state.messages);
    return { messages: [res] };
  })
  .addEdge(START, "agent")
  .addEdge("agent", END);

export const compile = (checkpointer: BaseCheckpointSaver) => builder.compile({ checkpointer });

// Local smoke test: npm run dev  (needs ANTHROPIC_API_KEY).
if (import.meta.url === "file://" + process.argv[1]) {
  const { MemorySaver } = await import("@langchain/langgraph");
  const graph = compile(new MemorySaver());
  const out = await graph.invoke(
    { messages: [new HumanMessage("Say hello in one sentence.")] },
    { configurable: { thread_id: "local" } },
  );
  console.log((out.messages.at(-1) as { content?: unknown } | undefined)?.content);
}
`

// src/app.ts — the hosting entry: mounts the standalone langgraph runtime.
const lgAppTs = `// Hosting entry for the OpenComputer langgraph runtime. createLangGraphRuntime wires
// the session transport (POST/GET /agents/:agent/:session + /health) and a per-session
// Durable Object that runs your graph with a durable DO-backed checkpointer. Keep both
// exports; LangGraphSession must match the class_name in wrangler.jsonc.
import { createLangGraphRuntime } from "@opencomputer/langgraph";
import { compile } from "./graph.js";

const runtime = createLangGraphRuntime({ compile });

export default { fetch: runtime.fetch };
export const LangGraphSession = runtime.SessionDO;
`

// wrangler.jsonc — the Worker + Durable Object binding for deploy.
const lgWrangler = `{
  "name": %q,
  "main": "src/app.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "name": "SESSION", "class_name": "LangGraphSession" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["LangGraphSession"] }]
}
`

const lgReadme = `# %s — LangGraph (JS) agent

An OpenComputer agent whose brain is a LangGraph.js ` + "`StateGraph`" + `.

## Author
Edit ` + "`src/graph.ts`" + ` — add nodes, edges, tools, conditional routing. Model calls
go through ` + "`ocModel(env)`" + ` (from @opencomputer/langgraph), which points a LangChain
Anthropic model at the OpenComputer gateway on deploy and at ANTHROPIC_API_KEY
locally. Keep ` + "`compile`" + ` exported — the runtime injects the durable checkpointer.

## Run locally
    npm install
    ANTHROPIC_API_KEY=sk-ant-... npm run dev

## Deploy
    oc agent deploy

## Hosting + durable state
` + "`src/app.ts`" + ` mounts createLangGraphRuntime — its own session transport plus one
Durable Object per session. Local ` + "`npm run dev`" + ` uses an in-memory MemorySaver; on
deploy the runtime injects a DurableObjectSaver automatically, so graph state
persists and resumes across invocations (Postgres/Redis savers can't run on Workers).
`

// scaffoldLangGraph writes a self-contained LangGraph.js project into dir.
func scaffoldLangGraph(dir, name, model string) error {
	if err := os.MkdirAll(filepath.Join(dir, "src"), 0o755); err != nil {
		return err
	}
	files := []struct{ path, content string }{
		{filepath.Join(dir, "agent.toml"), fmt.Sprintf(agentTomlTmpl, name, model, "langgraph")},
		{filepath.Join(dir, "package.json"), fmt.Sprintf(lgPackageJSON, name)},
		{filepath.Join(dir, "wrangler.jsonc"), fmt.Sprintf(lgWrangler, name)},
		{filepath.Join(dir, "tsconfig.json"), lgTsconfig},
		{filepath.Join(dir, ".gitignore"), lgGitignore},
		{filepath.Join(dir, "README.md"), fmt.Sprintf(lgReadme, name)},
		{filepath.Join(dir, "src", "graph.ts"), lgGraphTs},
		{filepath.Join(dir, "src", "app.ts"), lgAppTs},
	}
	return writeScaffold(files, dir, "Edit src/graph.ts, then:  npm install && oc agent deploy")
}

// writeScaffold writes each file (skipping existing), prints progress, and a footer.
func writeScaffold(files []struct{ path, content string }, dir, next string) error {
	created := 0
	for _, f := range files {
		if _, err := os.Stat(f.path); err == nil {
			fmt.Printf("  skip   %s (exists)\n", f.path)
			continue
		}
		if err := os.WriteFile(f.path, []byte(f.content), 0o644); err != nil {
			return err
		}
		fmt.Printf("  create %s\n", f.path)
		created++
	}
	fmt.Printf("\nScaffolded %d file(s). %s\n", created, next)
	return nil
}

var agentInitCmd = &cobra.Command{
	Use:   "init [dir]",
	Short: "Scaffold a deployable agent directory (prompt agent, or a langgraph project)",
	Example: "  oc agent init\n" +
		"  oc agent init ./agents/triage --name triage --model anthropic/claude-sonnet-5\n" +
		"  oc agent init ./agents/grapher --runtime langgraph",
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		dir := "."
		if len(args) > 0 {
			dir = args[0]
		}
		name, _ := cmd.Flags().GetString("name")
		model, _ := cmd.Flags().GetString("model")
		runtime, _ := cmd.Flags().GetString("runtime")
		if name == "" {
			if abs, err := filepath.Abs(dir); err == nil {
				name = filepath.Base(abs)
			}
			if name == "" || name == "." || name == string(filepath.Separator) {
				name = "my-agent"
			}
		}

		switch runtime {
		case "langgraph":
			return scaffoldLangGraph(dir, name, model)
		case "flue":
			return fmt.Errorf("flue scaffolding not wired yet; see sdks/flue oc-flue-starter (langgraph is: oc agent init --runtime langgraph)")
		default:
			// Prompt-based runtimes (claude|codex|pi).
			if err := os.MkdirAll(filepath.Join(dir, "skills", "example"), 0o755); err != nil {
				return err
			}
			files := []struct{ path, content string }{
				{filepath.Join(dir, "agent.toml"), fmt.Sprintf(agentTomlTmpl, name, model, runtime)},
				{filepath.Join(dir, "prompt.md"), promptTmpl},
				{filepath.Join(dir, "skills", "example", "SKILL.md"), skillTmpl},
			}
			return writeScaffold(files, dir, "Edit prompt.md, then:  oc agent deploy "+dir)
		}
	},
}

func init() {
	agentInitCmd.Flags().String("name", "", "Agent name (default: the directory name)")
	agentInitCmd.Flags().String("model", "anthropic/claude-sonnet-5", "Model")
	agentInitCmd.Flags().String("runtime", "claude", "Runtime family (claude|codex|pi|flue|langgraph)")
}
