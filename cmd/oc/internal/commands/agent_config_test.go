package commands

import (
	"strings"
	"testing"
)

func TestAgentSecretSetRejectsPositionalValue(t *testing.T) {
	if err := agentSecretSetCmd.Args(agentSecretSetCmd, []string{"TOKEN", "secret-value"}); err == nil {
		t.Fatal("expected a positional secret value to be rejected")
	}
}

func TestAgentSecretSetRequiresStdinFlag(t *testing.T) {
	if err := agentSecretSetCmd.Flags().Set("from-stdin", "false"); err != nil {
		t.Fatal(err)
	}
	err := agentSecretSetCmd.RunE(agentSecretSetCmd, []string{"TOKEN"})
	if err == nil || !strings.Contains(err.Error(), "--from-stdin") {
		t.Fatalf("error = %v, want --from-stdin requirement", err)
	}
}
