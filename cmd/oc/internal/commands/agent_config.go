package commands

// Flue Worker configuration. Non-secret vars can also live in agent.toml's
// [vars] section; secret values are accepted only by the write-only secret API.

import (
	"bufio"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/spf13/cobra"
)

type agentConfig struct {
	Vars               map[string]string `json:"vars"`
	EgressAllowlist    []string          `json:"egress_allowlist"`
	DeploymentRequired bool              `json:"deployment_required,omitempty"`
}

type agentSecret struct {
	Name       string `json:"name"`
	Last4      string `json:"last4"`
	UpdatedAt  string `json:"updated_at"`
	SyncStatus string `json:"sync_status"`
}

type agentSecretList struct {
	Data []agentSecret `json:"data"`
}

func agentConfigPath(id string) string  { return "/v3/agents/" + id + "/config" }
func agentSecretsPath(id string) string { return "/v3/agents/" + id + "/secrets" }
func agentSecretPath(id, name string) string {
	return agentSecretsPath(id) + "/" + url.PathEscape(name)
}

func getAgentConfig(cmd *cobra.Command, sc *client.Client, id string) (agentConfig, error) {
	var cfg agentConfig
	err := sc.Get(cmd.Context(), agentConfigPath(id), &cfg)
	if cfg.Vars == nil {
		cfg.Vars = map[string]string{}
	}
	return cfg, err
}

func putAgentConfig(cmd *cobra.Command, sc *client.Client, id string, cfg agentConfig) (agentConfig, error) {
	var saved agentConfig
	err := sc.PutJSON(cmd.Context(), agentConfigPath(id), map[string]interface{}{
		"vars": cfg.Vars, "egress_allowlist": cfg.EgressAllowlist,
	}, &saved)
	return saved, err
}

// syncManifestVars applies [vars] before a Flue deployment is enqueued. A nil
// Vars map means no section was supplied, so an ordinary deploy never erases
// config that was managed through the API/dashboard.
func syncManifestVars(cmd *cobra.Command, sc *client.Client, id string, m *manifest) error {
	if m.Vars == nil {
		return nil
	}
	cfg, err := getAgentConfig(cmd, sc, id)
	if err != nil {
		return fmt.Errorf("read agent config: %w", err)
	}
	cfg.Vars = m.Vars
	if _, err := putAgentConfig(cmd, sc, id, cfg); err != nil {
		return fmt.Errorf("sync agent.toml [vars]: %w", err)
	}
	return nil
}

func parseConfigVars(values []string) (map[string]string, error) {
	out := make(map[string]string, len(values))
	for _, raw := range values {
		name, value, ok := strings.Cut(raw, "=")
		name = strings.TrimSpace(name)
		if !ok || name == "" {
			return nil, fmt.Errorf("invalid --var %q (want NAME=VALUE)", raw)
		}
		out[name] = value
	}
	return out, nil
}

func sortedUnique(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			seen[value] = struct{}{}
		}
	}
	out := make([]string, 0, len(seen))
	for value := range seen {
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

var agentConfigCmd = &cobra.Command{
	Use:   "config [id|name]",
	Short: "Show or update a Flue agent's vars and outbound host allowlist",
	Long: "Show a Flue agent's Worker configuration. Update it with --var, --unset-var,\n" +
		"--allow-host, or --deny-host. Vars take effect on the next deploy; secrets use\n" +
		"`oc agent secret` and never appear here.",
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		id, err := targetAgentID(cmd, sc, args)
		if err != nil {
			return err
		}
		cfg, err := getAgentConfig(cmd, sc, id)
		if err != nil {
			return err
		}

		setVars, _ := cmd.Flags().GetStringArray("var")
		unsetVars, _ := cmd.Flags().GetStringArray("unset-var")
		allowHosts, _ := cmd.Flags().GetStringArray("allow-host")
		denyHosts, _ := cmd.Flags().GetStringArray("deny-host")
		clearVars, _ := cmd.Flags().GetBool("clear-vars")
		clearEgress, _ := cmd.Flags().GetBool("clear-egress")
		changing := len(setVars)+len(unsetVars)+len(allowHosts)+len(denyHosts) > 0 || clearVars || clearEgress
		if changing {
			parsed, err := parseConfigVars(setVars)
			if err != nil {
				return err
			}
			if clearVars {
				cfg.Vars = map[string]string{}
			}
			for name, value := range parsed {
				cfg.Vars[name] = value
			}
			for _, name := range unsetVars {
				delete(cfg.Vars, strings.TrimSpace(name))
			}
			if clearEgress {
				cfg.EgressAllowlist = nil
			}
			cfg.EgressAllowlist = append(cfg.EgressAllowlist, allowHosts...)
			denied := make(map[string]struct{}, len(denyHosts))
			for _, host := range denyHosts {
				denied[strings.TrimSpace(host)] = struct{}{}
			}
			hosts := cfg.EgressAllowlist[:0]
			for _, host := range sortedUnique(cfg.EgressAllowlist) {
				if _, remove := denied[host]; !remove {
					hosts = append(hosts, host)
				}
			}
			cfg.EgressAllowlist = hosts
			cfg, err = putAgentConfig(cmd, sc, id, cfg)
			if err != nil {
				return err
			}
		}

		printer.Print(cfg, func() {
			if len(cfg.Vars) == 0 {
				fmt.Println("Vars: (none)")
			} else {
				fmt.Println("Vars:")
				keys := make([]string, 0, len(cfg.Vars))
				for key := range cfg.Vars {
					keys = append(keys, key)
				}
				sort.Strings(keys)
				for _, key := range keys {
					fmt.Printf("  %s=%s\n", key, cfg.Vars[key])
				}
			}
			if len(cfg.EgressAllowlist) == 0 {
				fmt.Println("Outbound hosts: (none; fail-closed)")
			} else {
				fmt.Println("Outbound hosts:")
				for _, host := range cfg.EgressAllowlist {
					fmt.Printf("  %s\n", host)
				}
			}
			if changing {
				fmt.Println("Saved. Vars apply on the next deploy; egress policy applies shortly.")
			}
		})
		return nil
	},
}

var agentSecretCmd = &cobra.Command{
	Use:   "secret",
	Short: "Manage write-only Flue Worker secrets",
}

var agentSecretListCmd = &cobra.Command{
	Use:     "list [id|name]",
	Aliases: []string{"ls"},
	Short:   "List secret metadata (values are never returned)",
	Args:    cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		id, err := targetAgentID(cmd, sc, args)
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
				rows = append(rows, []string{secret.Name, secret.Last4, secret.SyncStatus, formatAge(secret.UpdatedAt)})
			}
			printer.Table([]string{"NAME", "LAST4", "STATUS", "UPDATED"}, rows)
		})
		return nil
	},
}

var agentSecretSetCmd = &cobra.Command{
	Use:   "set <name> [value]",
	Short: "Set or rotate a Worker secret",
	Long: "Set a write-only Flue Worker secret. Prefer --from-stdin so the value does not\n" +
		"enter shell history. The live Worker is updated in place when already deployed.",
	Args: cobra.RangeArgs(1, 2),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		id, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		fromStdin, _ := cmd.Flags().GetBool("from-stdin")
		var value string
		switch {
		case fromStdin && len(args) == 2:
			return fmt.Errorf("pass the value or --from-stdin, not both")
		case fromStdin:
			scanner := bufio.NewScanner(os.Stdin)
			var lines []string
			for scanner.Scan() {
				lines = append(lines, scanner.Text())
			}
			if err := scanner.Err(); err != nil {
				return fmt.Errorf("reading stdin: %w", err)
			}
			value = strings.Join(lines, "\n")
		case len(args) == 2:
			value = args[1]
		default:
			return fmt.Errorf("provide a value or use --from-stdin")
		}
		if value == "" {
			return fmt.Errorf("secret value cannot be empty")
		}
		var saved agentSecret
		if err := sc.PutJSON(cmd.Context(), agentSecretPath(id, args[0]), map[string]string{"value": value}, &saved); err != nil {
			return err
		}
		printer.Print(saved, func() { fmt.Printf("Secret %s set (%s).\n", saved.Name, saved.SyncStatus) })
		return nil
	},
}

var agentSecretDeleteCmd = &cobra.Command{
	Use:     "delete <name>",
	Aliases: []string{"rm"},
	Short:   "Delete a Worker secret",
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
		fmt.Printf("Secret %s deleted.\n", args[0])
		return nil
	},
}

func registerAgentConfig() {
	agentConfigCmd.Flags().String("agent", "", "Target agent id or name (else the cwd agent.toml)")
	agentConfigCmd.Flags().StringArray("var", nil, "Set a non-secret binding (NAME=VALUE; repeatable)")
	agentConfigCmd.Flags().StringArray("unset-var", nil, "Remove a non-secret binding (repeatable)")
	agentConfigCmd.Flags().StringArray("allow-host", nil, "Allow outbound HTTPS to a hostname (repeatable; supports *.example.com)")
	agentConfigCmd.Flags().StringArray("deny-host", nil, "Remove a hostname from the outbound allowlist (repeatable)")
	agentConfigCmd.Flags().Bool("clear-vars", false, "Remove all non-secret bindings")
	agentConfigCmd.Flags().Bool("clear-egress", false, "Return outbound HTTPS to fail-closed defaults")

	for _, command := range []*cobra.Command{agentSecretListCmd, agentSecretSetCmd, agentSecretDeleteCmd} {
		command.Flags().String("agent", "", "Target agent id or name (else the cwd agent.toml)")
	}
	agentSecretSetCmd.Flags().Bool("from-stdin", false, "Read the secret value from stdin")
	agentSecretCmd.AddCommand(agentSecretListCmd, agentSecretSetCmd, agentSecretDeleteCmd)
	agentCmd.AddCommand(agentConfigCmd, agentSecretCmd)
}
