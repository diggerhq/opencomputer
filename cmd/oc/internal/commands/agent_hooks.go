package commands

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/spf13/cobra"
)

type AgentHook struct {
	ID            string  `json:"id"`
	AgentID       string  `json:"agent_id"`
	Name          string  `json:"name"`
	Status        string  `json:"status"`
	SecretLast4   string  `json:"secret_last4"`
	RevokedReason *string `json:"revoked_reason"`
	ExpiresAt     *string `json:"expires_at"`
	CreatedAt     string  `json:"created_at"`
}

type AgentHookCreateResponse struct {
	Hook    AgentHook `json:"hook"`
	HookURL string    `json:"hook_url"`
}

type agentHookListResponse struct {
	Data       []AgentHook `json:"data"`
	NextCursor *string     `json:"next_cursor"`
}

func agentHookListPath(agentID string, includeRevoked bool, cursor string, limit int) string {
	query := url.Values{}
	if includeRevoked {
		query.Set("include_revoked", "true")
	}
	if cursor != "" {
		query.Set("cursor", cursor)
	}
	if limit > 0 {
		query.Set("limit", fmt.Sprintf("%d", limit))
	}
	path := "/v3/agents/" + agentID + "/hooks"
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}
	return path
}

func resolveHookID(cmd *cobra.Command, sc *client.Client, agentID, ref string) (string, error) {
	if strings.HasPrefix(ref, "hk_") {
		return ref, nil
	}
	var current []AgentHook
	var revoked []AgentHook
	cursor := ""
	for {
		var response agentHookListResponse
		if err := sc.Get(
			cmd.Context(),
			agentHookListPath(agentID, true, cursor, 100),
			&response,
		); err != nil {
			return "", err
		}
		for _, hook := range response.Data {
			if hook.Name != ref {
				continue
			}
			if hook.Status == "revoked" {
				revoked = append(revoked, hook)
			} else {
				current = append(current, hook)
			}
		}
		if response.NextCursor == nil || *response.NextCursor == "" {
			break
		}
		cursor = *response.NextCursor
	}
	if len(current) == 1 {
		return current[0].ID, nil
	}
	if len(current) > 1 {
		return "", fmt.Errorf("multiple current Hooks named %q; use a Hook id", ref)
	}
	if len(revoked) == 1 {
		return revoked[0].ID, nil
	}
	if len(revoked) > 1 {
		return "", fmt.Errorf("multiple revoked Hooks named %q; use a Hook id", ref)
	}
	return "", fmt.Errorf("no Hook named %q on this agent", ref)
}

func hookReason(reason *string) string {
	if reason == nil || *reason == "" {
		return "-"
	}
	if *reason == "secret_exposure" {
		return "secret exposure"
	}
	return *reason
}

func hookExpiry(expiresAt *string) string {
	if expiresAt == nil || *expiresAt == "" {
		return "never"
	}
	return *expiresAt
}

var agentHooksCmd = &cobra.Command{
	Use:   "hooks",
	Short: "List an agent's Hook URLs",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, _ []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		agentID, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		includeRevoked, _ := cmd.Flags().GetBool("include-revoked")
		cursor, _ := cmd.Flags().GetString("cursor")
		limit, _ := cmd.Flags().GetInt("limit")
		var response agentHookListResponse
		if err := sc.Get(
			cmd.Context(),
			agentHookListPath(agentID, includeRevoked, cursor, limit),
			&response,
		); err != nil {
			return err
		}
		printer.Print(response, func() {
			if len(response.Data) == 0 {
				fmt.Println("No Hook URLs.")
				return
			}
			rows := make([][]string, 0, len(response.Data))
			for _, hook := range response.Data {
				rows = append(rows, []string{
					hook.Name,
					hook.ID,
					hook.Status,
					hook.SecretLast4,
					hookExpiry(hook.ExpiresAt),
					hookReason(hook.RevokedReason),
				})
			}
			printer.Table([]string{"NAME", "ID", "STATUS", "LAST4", "EXPIRES", "REVOKED"}, rows)
			if response.NextCursor != nil {
				fmt.Printf("More: oc agent hooks --agent %s --cursor %s\n", agentID, *response.NextCursor)
			}
		})
		return nil
	},
}

var agentHookCmd = &cobra.Command{
	Use:   "hook",
	Short: "Create, inspect, and revoke Agent Hook URLs",
}

var agentHookCreateCmd = &cobra.Command{
	Use:   "create <name>",
	Short: "Create a named Hook URL",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		agentID, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		body := map[string]interface{}{"name": args[0]}
		if expiresAt, _ := cmd.Flags().GetString("expires-at"); expiresAt != "" {
			body["expires_at"] = expiresAt
		}
		var response AgentHookCreateResponse
		if err := sc.Post(cmd.Context(), "/v3/agents/"+agentID+"/hooks", body, &response); err != nil {
			return err
		}
		printer.Print(response, func() {
			fmt.Printf("Created Hook %s (%s)\n", response.Hook.Name, response.Hook.ID)
			fmt.Printf("URL: %s\n", response.HookURL)
			fmt.Println("Copy it now. The complete URL cannot be retrieved again.")
		})
		return nil
	},
}

var agentHookGetCmd = &cobra.Command{
	Use:   "get <id|name>",
	Short: "Show a Hook without its secret URL",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		agentID, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		hookID, err := resolveHookID(cmd, sc, agentID, args[0])
		if err != nil {
			return err
		}
		var hook AgentHook
		if err := sc.Get(cmd.Context(), "/v3/agents/"+agentID+"/hooks/"+hookID, &hook); err != nil {
			return err
		}
		printer.Print(hook, func() {
			fmt.Printf("Name:     %s\n", hook.Name)
			fmt.Printf("ID:       %s\n", hook.ID)
			fmt.Printf("Status:   %s\n", hook.Status)
			fmt.Printf("Last 4:   %s\n", hook.SecretLast4)
			fmt.Printf("Expires:  %s\n", hookExpiry(hook.ExpiresAt))
			fmt.Printf("Revoked:  %s\n", hookReason(hook.RevokedReason))
		})
		return nil
	},
}

var agentHookRevokeCmd = &cobra.Command{
	Use:   "revoke <id|name>",
	Short: "Permanently revoke a Hook URL",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		agentID, err := targetAgentID(cmd, sc, nil)
		if err != nil {
			return err
		}
		hookID, err := resolveHookID(cmd, sc, agentID, args[0])
		if err != nil {
			return err
		}
		if err := confirmDestructive(cmd, fmt.Sprintf("Permanently revoke Hook %s", args[0])); err != nil {
			return err
		}
		if err := sc.Delete(cmd.Context(), "/v3/agents/"+agentID+"/hooks/"+hookID); err != nil {
			return err
		}
		printer.Print(map[string]string{"id": hookID, "status": "revoked"}, func() {
			fmt.Printf("Revoked Hook %s.\n", hookID)
		})
		return nil
	},
}

func registerAgentHooks() {
	for _, command := range []*cobra.Command{
		agentHooksCmd,
		agentHookCreateCmd,
		agentHookGetCmd,
		agentHookRevokeCmd,
	} {
		command.Flags().String("agent", "", "Agent id or name (else the cwd agent.toml)")
	}
	agentHooksCmd.Flags().Bool("include-revoked", false, "Include revoked Hooks")
	agentHooksCmd.Flags().String("cursor", "", "Continue a previous list page")
	agentHooksCmd.Flags().Int("limit", 0, "Maximum Hooks to return (server caps at 100)")
	agentHookCreateCmd.Flags().String("expires-at", "", "RFC 3339 expiry (default: no expiry)")
	agentHookRevokeCmd.Flags().Bool("yes", false, "Skip the confirmation prompt")
	agentHookCmd.AddCommand(agentHookCreateCmd, agentHookGetCmd, agentHookRevokeCmd)
	agentCmd.AddCommand(agentHooksCmd, agentHookCmd)
}
