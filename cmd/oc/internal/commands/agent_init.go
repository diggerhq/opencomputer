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
family = %q   # claude | codex | pi | flue
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

var agentInitCmd = &cobra.Command{
	Use:   "init [dir]",
	Short: "Scaffold a deployable agent directory (agent.toml + prompt.md + skills/)",
	Example: "  oc agent init\n" +
		"  oc agent init ./agents/triage --name triage --model anthropic/claude-sonnet-5\n" +
		"  oc agent init ./agents/edge --runtime flue\n" +
		"  oc agent init && $EDITOR prompt.md && oc agent deploy",
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

		if err := os.MkdirAll(filepath.Join(dir, "skills", "example"), 0o755); err != nil {
			return err
		}
		files := []struct{ path, content string }{
			{filepath.Join(dir, "agent.toml"), fmt.Sprintf(agentTomlTmpl, name, model, runtime)},
			{filepath.Join(dir, "prompt.md"), promptTmpl},
			{filepath.Join(dir, "skills", "example", "SKILL.md"), skillTmpl},
		}
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
		if runtime == "flue" {
			fmt.Printf(
				"\nScaffolded %d file(s). Edit prompt.md, push this directory to GitHub, then import it from Agents → Create agent.\n",
				created,
			)
		} else {
			fmt.Printf("\nScaffolded %d file(s). Edit prompt.md, then:  oc agent deploy %s\n", created, dir)
		}
		return nil
	},
}

func init() {
	agentInitCmd.Flags().String("name", "", "Agent name (default: the directory name)")
	agentInitCmd.Flags().String("model", "anthropic/claude-sonnet-5", "Model")
	agentInitCmd.Flags().String("runtime", "claude", "Runtime family (claude|codex|pi|flue)")
}
