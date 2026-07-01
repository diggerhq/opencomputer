package commands

// `oc session watch|watches|unwatch` — PR watches (design 010). A watch wakes the
// session when a PR it opened changes (checks finish, a review/comment lands, it
// merges/closes). Only PRs the same session opened, on OpenComputer-App repos.

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

type Watch struct {
	ID             string `json:"id"`
	Type           string `json:"type"`
	Repo           string `json:"repo"`
	PR             int    `json:"pr"`
	WakeOn         string `json:"wake_on"`
	Intent         string `json:"intent,omitempty"`
	Status         string `json:"status"`
	Origin         string `json:"origin"`
	LastSnapshotAt string `json:"last_snapshot_at,omitempty"`
	ExpiresAt      string `json:"expires_at,omitempty"`
	CreatedAt      string `json:"created_at"`
}

type WatchEnvelope struct {
	Watch Watch `json:"watch"`
}

type WatchList struct {
	Data []Watch `json:"data"`
}

var wakeOns = []string{"checks", "review", "comment", "merge"}

var sessionWatchCmd = &cobra.Command{
	Use:   "watch <id>",
	Short: "Watch a PR the session opened (wake it on PR changes)",
	Long: "Declare a watch: OpenComputer wakes the session when the watched PR changes.\n\n" +
		"wake_on picks the condition — checks (CI finishes, default), review (a review\n" +
		"decision), comment (a new comment), or merge (the PR merges/closes). --repo/--pr\n" +
		"are optional; omitted, they resolve to the PR this session opened.",
	Example: "  oc session watch ses_123 --wake-on review --intent \"address review feedback\"\n" +
		"  oc session watch ses_123                     # wake_on=checks (default)",
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		wakeOn, _ := cmd.Flags().GetString("wake-on")
		if !contains(wakeOns, wakeOn) {
			return fmt.Errorf("--wake-on must be one of %s", strings.Join(wakeOns, ", "))
		}
		repo, _ := cmd.Flags().GetString("repo")
		pr, _ := cmd.Flags().GetInt("pr")
		intent, _ := cmd.Flags().GetString("intent")

		body := map[string]interface{}{"type": "github_pr", "wake_on": wakeOn}
		if repo != "" {
			body["repo"] = repo
		}
		if pr > 0 {
			body["pr"] = pr
		}
		if intent != "" {
			body["intent"] = intent
		}
		var env WatchEnvelope
		if err := sc.Post(cmd.Context(), "/v3/sessions/"+args[0]+"/watches", body, &env); err != nil {
			return err
		}
		printer.Print(env.Watch, func() {
			w := env.Watch
			fmt.Printf("Watching %s#%d — wake on %s (%s)\n", w.Repo, w.PR, w.WakeOn, w.Status)
			fmt.Printf("Watch id: %s\n", w.ID)
			if w.Status == "auth_required" {
				fmt.Println("Note: the OpenComputer GitHub App needs its watch permissions re-accepted; re-declare once fixed.")
			}
		})
		return nil
	},
}

var sessionWatchesCmd = &cobra.Command{
	Use:     "watches <id>",
	Short:   "List a session's watches",
	Args:    cobra.ExactArgs(1),
	Aliases: []string{"watch-list"},
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		var resp WatchList
		if err := sc.Get(cmd.Context(), "/v3/sessions/"+args[0]+"/watches", &resp); err != nil {
			return err
		}
		printer.Print(resp.Data, func() {
			if len(resp.Data) == 0 {
				fmt.Println("No watches.")
				return
			}
			headers := []string{"ID", "REPO", "PR", "WAKE ON", "STATUS", "INTENT"}
			var rows [][]string
			for _, w := range resp.Data {
				rows = append(rows, []string{w.ID, w.Repo, fmt.Sprintf("%d", w.PR), w.WakeOn, w.Status, truncStr(w.Intent, 40)})
			}
			printer.Table(headers, rows)
		})
		return nil
	},
}

var sessionUnwatchCmd = &cobra.Command{
	Use:     "unwatch <id> <watch-id>",
	Short:   "Remove a watch",
	Example: "  oc session unwatch ses_123 wch_abc",
	Args:    cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		if err := sc.Delete(cmd.Context(), "/v3/sessions/"+args[0]+"/watches/"+args[1]); err != nil {
			return err
		}
		fmt.Printf("Removed watch %s\n", args[1])
		return nil
	},
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func truncStr(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= n {
		return s
	}
	if n <= 1 {
		return s[:n]
	}
	return s[:n-1] + "…"
}

func init() {
	sessionWatchCmd.Flags().String("wake-on", "checks", "Wake condition: checks | review | comment | merge")
	sessionWatchCmd.Flags().String("repo", "", "owner/repo (default: the PR this session opened)")
	sessionWatchCmd.Flags().Int("pr", 0, "PR number (default: the session's sole owned PR)")
	sessionWatchCmd.Flags().String("intent", "", "Freeform note (\"why\"), replayed to the agent on wake")

	sessionCmd.AddCommand(sessionWatchCmd)
	sessionCmd.AddCommand(sessionWatchesCmd)
	sessionCmd.AddCommand(sessionUnwatchCmd)
}
