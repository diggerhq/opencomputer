package commands

// Preview Flue configuration has one source of truth: non-secret vars come from agent.toml and
// write-only secrets come from this command. Both are applied by the next explicit agent deploy.

import (
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/spf13/cobra"
)

type agentConfig struct {
	Vars               map[string]string `json:"vars"`
	DeploymentRequired bool              `json:"deployment_required,omitempty"`
}

type agentSecret struct {
	Name               string `json:"name"`
	Last4              string `json:"last4"`
	UpdatedAt          string `json:"updated_at"`
	DeploymentRequired bool   `json:"deployment_required,omitempty"`
}

type agentSecretList struct {
	Data []agentSecret `json:"data"`
}

func agentConfigPath(id string) string  { return "/v3/agents/" + id + "/config" }
func agentSecretsPath(id string) string { return "/v3/agents/" + id + "/secrets" }
func agentSecretPath(id, name string) string {
	return agentSecretsPath(id) + "/" + url.PathEscape(name)
}

// syncManifestVars makes agent.toml the only non-secret config source. An absent [vars] section is
// an empty desired map, so deleting the section and deploying removes prior bindings.
func syncManifestVars(cmd *cobra.Command, sc *client.Client, id string, m *manifest) error {
	vars := m.Vars
	if vars == nil {
		vars = map[string]string{}
	}
	var saved agentConfig
	if err := sc.PutJSON(cmd.Context(), agentConfigPath(id), map[string]interface{}{"vars": vars}, &saved); err != nil {
		return fmt.Errorf("sync agent.toml [vars]: %w", err)
	}
	return nil
}

var agentSecretCmd = &cobra.Command{
	Use:   "secret",
	Short: "Manage write-only Flue Worker secrets for the next deploy",
}

var agentSecretListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List secret metadata (values are never returned)",
	Args:    cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		id, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		var res agentSecretList
		if err := sc.Get(cmd.Context(), agentSecretsPath(id), &res); err != nil {
			return err
		}
		printer.Print(res.Data, func() {
			if len(res.Data) == 0 {
				fmt.Println("No secrets.")
				return
			}
			rows := make([][]string, 0, len(res.Data))
			for _, secret := range res.Data {
				rows = append(rows, []string{secret.Name, secret.Last4, formatAge(secret.UpdatedAt)})
			}
			printer.Table([]string{"NAME", "LAST4", "UPDATED"}, rows)
		})
		return nil
	},
}

var agentSecretSetCmd = &cobra.Command{
	Use:   "set <name> --from-stdin",
	Short: "Save or rotate a Worker secret for the next deploy",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		fromStdin, _ := cmd.Flags().GetBool("from-stdin")
		if !fromStdin {
			return fmt.Errorf("secret values are accepted only via --from-stdin")
		}
		raw, err := io.ReadAll(os.Stdin)
		if err != nil {
			return fmt.Errorf("reading stdin: %w", err)
		}
		value := strings.TrimSuffix(strings.TrimSuffix(string(raw), "\n"), "\r")
		if value == "" {
			return fmt.Errorf("secret value cannot be empty")
		}

		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		id, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		var saved agentSecret
		if err := sc.PutJSON(cmd.Context(), agentSecretPath(id, args[0]), map[string]string{"value": value}, &saved); err != nil {
			return err
		}
		printer.Print(saved, func() {
			fmt.Printf("Secret %s saved. Run `oc agent deploy` to apply it.\n", saved.Name)
		})
		return nil
	},
}

var agentSecretDeleteCmd = &cobra.Command{
	Use:     "delete <name>",
	Aliases: []string{"rm"},
	Short:   "Remove a Worker secret on the next deploy",
	Args:    cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		id, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		if err := sc.Delete(cmd.Context(), agentSecretPath(id, args[0])); err != nil {
			return err
		}
		fmt.Printf("Secret %s removed. Run `oc agent deploy` to apply it.\n", args[0])
		return nil
	},
}

func registerAgentConfig() {
	for _, command := range []*cobra.Command{agentSecretListCmd, agentSecretSetCmd, agentSecretDeleteCmd} {
		command.Flags().String("agent", "", "Target agent id or name (else the cwd agent.toml)")
	}
	agentSecretSetCmd.Flags().Bool("from-stdin", false, "Read the secret value from stdin")
	agentSecretCmd.AddCommand(agentSecretListCmd, agentSecretSetCmd, agentSecretDeleteCmd)
	agentCmd.AddCommand(agentSecretCmd)
}
