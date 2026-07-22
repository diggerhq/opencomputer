package commands

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/config"
	"github.com/spf13/cobra"
)

const agentInvokeResponseMaxBytes = 1 << 20

type AgentInvokeReceipt struct {
	RequestID string `json:"request_id"`
	Session   struct {
		ID     string `json:"id"`
		Status string `json:"status"`
		Head   int    `json:"head"`
	} `json:"session"`
	ClientToken string `json:"client_token,omitempty"`
	Links       struct {
		Events   string `json:"events"`
		Messages string `json:"messages"`
	} `json:"links"`
	Replayed bool `json:"replayed"`
}

type invokeWait func(context.Context, time.Duration) error

func waitForInvokeRetry(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func generatedInvokeKey() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate idempotency key: %w", err)
	}
	return "oc-cli-" + hex.EncodeToString(value[:]), nil
}

func invokeRetryDelay(response *http.Response, attempt int) time.Duration {
	if raw := response.Header.Get("Retry-After"); raw != "" {
		if seconds, err := strconv.Atoi(raw); err == nil && seconds > 0 {
			return min(time.Duration(seconds)*time.Second, 8*time.Second)
		}
	}
	return min(250*time.Millisecond*time.Duration(1<<attempt), 2*time.Second)
}

func readBoundedResponse(response *http.Response) ([]byte, error) {
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, agentInvokeResponseMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > agentInvokeResponseMaxBytes {
		return nil, fmt.Errorf("Agent URL response exceeds %d bytes", agentInvokeResponseMaxBytes)
	}
	return body, nil
}

func invokeAgentURL(
	ctx context.Context,
	httpClient *http.Client,
	apiKey string,
	invokeURL string,
	body []byte,
	idempotencyKey string,
	maxRetries int,
	wait invokeWait,
) (AgentInvokeReceipt, error) {
	var receipt AgentInvokeReceipt
	target := strings.TrimRight(invokeURL, "/") + "/"

	for attempt := 0; ; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
		if err != nil {
			return receipt, err
		}
		request.Header.Set("Authorization", "Bearer "+apiKey)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", idempotencyKey)

		response, err := httpClient.Do(request)
		if err != nil {
			if attempt < maxRetries && ctx.Err() == nil {
				if waitErr := wait(ctx, min(250*time.Millisecond*time.Duration(1<<attempt), 2*time.Second)); waitErr != nil {
					return receipt, waitErr
				}
				continue
			}
			return receipt, err
		}

		retryable := response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500
		if retryable && attempt < maxRetries {
			delay := invokeRetryDelay(response, attempt)
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, agentInvokeResponseMaxBytes))
			response.Body.Close()
			if err := wait(ctx, delay); err != nil {
				return receipt, err
			}
			continue
		}

		responseBody, err := readBoundedResponse(response)
		if err != nil {
			return receipt, err
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			var envelope struct {
				Error struct {
					Message string `json:"message"`
				} `json:"error"`
			}
			message := strings.TrimSpace(string(responseBody))
			if json.Unmarshal(responseBody, &envelope) == nil && envelope.Error.Message != "" {
				message = envelope.Error.Message
			}
			return receipt, &client.APIError{StatusCode: response.StatusCode, Message: message}
		}
		if err := json.Unmarshal(responseBody, &receipt); err != nil {
			return receipt, fmt.Errorf("decode Agent URL response: %w", err)
		}
		return receipt, nil
	}
}

func agentInvokeInput(cmd *cobra.Command) ([]byte, error) {
	data, _ := cmd.Flags().GetString("data")
	path, _ := cmd.Flags().GetString("file")
	fromStdin, _ := cmd.Flags().GetBool("stdin")
	selected := 0
	if cmd.Flags().Changed("data") {
		selected++
	}
	if path != "" {
		selected++
	}
	if fromStdin {
		selected++
	}
	if selected > 1 {
		return nil, fmt.Errorf("use only one of --data, --file, or --stdin")
	}

	var body []byte
	var err error
	switch {
	case path != "":
		body, err = os.ReadFile(path)
	case fromStdin:
		body, err = io.ReadAll(os.Stdin)
	default:
		body = []byte(data)
	}
	if err != nil {
		return nil, err
	}
	if !json.Valid(body) {
		return nil, fmt.Errorf("invocation body must be valid JSON")
	}
	return body, nil
}

var agentInvokeCmd = &cobra.Command{
	Use:   "invoke <id|name>",
	Short: "Start a session through an agent's canonical URL",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		sc, err := sessionsClient(cmd)
		if err != nil {
			return err
		}
		agentID, err := resolveRef(cmd, sc, args[0])
		if err != nil {
			return err
		}
		var agent Agent
		if err := sc.Get(cmd.Context(), "/v3/agents/"+agentID, &agent); err != nil {
			return err
		}
		if agent.InvokeURL == "" {
			return fmt.Errorf("agent response did not include invoke_url")
		}

		body, err := agentInvokeInput(cmd)
		if err != nil {
			return err
		}
		key, _ := cmd.Flags().GetString("idempotency-key")
		if key == "" {
			key, err = generatedInvokeKey()
			if err != nil {
				return err
			}
		}
		cfg := config.Load(cmd)
		if cfg.APIKey == "" {
			return fmt.Errorf("OpenComputer API key is required")
		}
		httpClient := &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return fmt.Errorf("Agent URL must not redirect")
			},
		}
		receipt, err := invokeAgentURL(
			cmd.Context(), httpClient, cfg.APIKey, agent.InvokeURL, body, key, 2, waitForInvokeRetry,
		)
		if err != nil {
			return err
		}
		printer.Print(receipt, func() {
			fmt.Printf("Accepted session %s (status: %s)\n", receipt.Session.ID, receipt.Session.Status)
			fmt.Printf("Follow:  oc session logs %s\n", receipt.Session.ID)
			fmt.Printf("Steer:   oc session steer %s \"message\"\n", receipt.Session.ID)
		})
		return nil
	},
}

func registerAgentInvoke() {
	agentInvokeCmd.Flags().String("data", "{}", "JSON request body")
	agentInvokeCmd.Flags().String("file", "", "Read the JSON request body from a file")
	agentInvokeCmd.Flags().Bool("stdin", false, "Read the JSON request body from stdin")
	agentInvokeCmd.Flags().String("idempotency-key", "", "Reuse a logical invocation across retries")
	agentCmd.AddCommand(agentInvokeCmd)
}
