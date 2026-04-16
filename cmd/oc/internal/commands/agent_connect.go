package commands

// Channel lifecycle: connect, disconnect, list. The Telegram case prompts
// interactively for a bot token since there's no --bot-token flag yet
// (tracked as a launch-prep item).

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

var agentConnectCmd = &cobra.Command{
	Use:   "connect <id> <channel>",
	Short: "Connect a channel to an agent",
	Long:  "Connect a messaging channel (e.g. telegram) to a managed agent.",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}

		agentID := args[0]
		channel := args[1]

		body := map[string]interface{}{}

		if channel == "telegram" {
			fmt.Println("To connect Telegram:")
			fmt.Println("  1. Open Telegram and message @BotFather")
			fmt.Println("  2. Send /newbot, choose a name and username")
			fmt.Println("  3. Copy the bot token")
			fmt.Println()
			fmt.Print("Paste bot token: ")

			reader := bufio.NewReader(os.Stdin)
			token, _ := reader.ReadString('\n')
			token = strings.TrimSpace(token)
			if token == "" {
				return fmt.Errorf("bot token is required")
			}
			body["bot_token"] = token
		}

		var result map[string]interface{}
		if err := sc.Post(cmd.Context(), "/v1/agents/"+agentID+"/channels/"+channel, body, &result); err != nil {
			return err
		}

		fmt.Printf("Telegram connected to %s.\n", agentID)
		if channel == "telegram" {
			fmt.Println("Message your bot on Telegram to start chatting.")
		}
		return nil
	},
}

var agentDisconnectCmd = &cobra.Command{
	Use:   "disconnect <id> <channel>",
	Short: "Disconnect a channel from an agent",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}

		if err := sc.Delete(cmd.Context(), "/v1/agents/"+args[0]+"/channels/"+args[1]); err != nil {
			return err
		}

		fmt.Printf("Channel %s disconnected from %s.\n", args[1], args[0])
		return nil
	},
}

var agentChannelsCmd = &cobra.Command{
	Use:   "channels <id>",
	Short: "List channels connected to an agent",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}

		var resp map[string]interface{}
		if err := sc.Get(cmd.Context(), "/v1/agents/"+args[0]+"/channels", &resp); err != nil {
			return err
		}

		printer.Print(resp, func() {
			channels := formatList(resp["channels"])
			if channels == "-" {
				fmt.Println("No channels connected.")
			} else {
				fmt.Printf("Channels: %s\n", channels)
			}
		})
		return nil
	},
}
