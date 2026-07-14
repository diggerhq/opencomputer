package qemu

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/opensandbox/opensandbox/pkg/types"
)

func commandString(command networkCommand) string {
	return command.name + " " + strings.Join(command.args, " ")
}

func TestPublicNetworkPolicyCommands(t *testing.T) {
	t.Parallel()

	tapName := "qm-tap0000042"
	cfg := &NetworkConfig{TAPName: tapName, GuestIP: "172.16.0.170"}
	commands := publicNetworkPolicyCommands(cfg)
	commandStrings := make([]string, len(commands))
	for i, command := range commands {
		commandStrings[i] = commandString(command)
	}

	input4, egress4, ingress4, input6, egress6, ingress6 := networkPolicyChainNames(tapName)
	for _, want := range []string{
		"iptables -I INPUT 1 -i " + tapName + " -j " + input4,
		"iptables -A " + input4 + " -j DROP",
		"iptables -I FORWARD 1 -i " + tapName + " -j " + egress4,
		"iptables -A " + egress4 + " ! -s 172.16.0.170/32 -j DROP",
		"iptables -A " + egress4 + " -j ACCEPT",
		"iptables -I FORWARD 1 -o " + tapName + " -j " + ingress4,
		"iptables -I OUTPUT 1 -o " + tapName + " -j " + ingress4,
		"iptables -A " + ingress4 + " -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
		"iptables -A " + ingress4 + " -j DROP",
		"ip6tables -I INPUT 1 -i " + tapName + " -j " + input6,
		"ip6tables -A " + input6 + " -j DROP",
		"ip6tables -I FORWARD 1 -i " + tapName + " -j " + egress6,
		"ip6tables -A " + egress6 + " -j DROP",
		"ip6tables -I FORWARD 1 -o " + tapName + " -j " + ingress6,
		"ip6tables -I OUTPUT 1 -o " + tapName + " -j " + ingress6,
		"ip6tables -A " + ingress6 + " -j DROP",
	} {
		if !slices.Contains(commandStrings, want) {
			t.Errorf("missing firewall command %q", want)
		}
	}

	antiSpoof := slices.Index(commandStrings, "iptables -A "+egress4+" ! -s 172.16.0.170/32 -j DROP")
	publicAccept := slices.Index(commandStrings, "iptables -A "+egress4+" -j ACCEPT")
	if antiSpoof < 0 || publicAccept < 0 || antiSpoof >= publicAccept {
		t.Fatalf("anti-spoof rule must precede the public allow rule: %v", commandStrings)
	}
	established := slices.Index(commandStrings, "iptables -A "+ingress4+" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT")
	inboundDrop := slices.Index(commandStrings, "iptables -A "+ingress4+" -j DROP")
	if established < 0 || inboundDrop < 0 || established >= inboundDrop {
		t.Fatalf("established replies must precede the new-inbound drop: %v", commandStrings)
	}
	for _, cidr := range publicBlockedIPv4CIDRs {
		blocked := slices.Index(commandStrings, "iptables -A "+egress4+" -d "+cidr+" -j DROP")
		if blocked < 0 {
			t.Errorf("missing blocked destination %s", cidr)
		} else if blocked <= antiSpoof || blocked >= publicAccept {
			t.Errorf("blocked destination %s is not between anti-spoof and public allow rules", cidr)
		}
	}

	firstJump := len(commands)
	lastChainRule := -1
	for i, command := range commands {
		if len(command.args) < 1 {
			continue
		}
		switch command.args[0] {
		case "-I":
			if i < firstJump {
				firstJump = i
			}
		case "-N", "-A":
			lastChainRule = i
		}
	}
	if lastChainRule < 0 || firstJump == len(commands) || lastChainRule >= firstJump {
		t.Fatalf("all fail-closed chains must be populated before jumps are installed: %v", commandStrings)
	}

	cleanupStrings := make([]string, 0, len(networkPolicyCleanupCommands(tapName)))
	for _, command := range networkPolicyCleanupCommands(tapName) {
		cleanupStrings = append(cleanupStrings, commandString(command))
	}
	for _, want := range []string{
		"iptables -D INPUT -i " + tapName + " -j " + input4,
		"iptables -D FORWARD -i " + tapName + " -j " + egress4,
		"iptables -D FORWARD -o " + tapName + " -j " + ingress4,
		"iptables -D OUTPUT -o " + tapName + " -j " + ingress4,
		"ip6tables -D INPUT -i " + tapName + " -j " + input6,
		"ip6tables -D FORWARD -i " + tapName + " -j " + egress6,
		"ip6tables -D FORWARD -o " + tapName + " -j " + ingress6,
		"ip6tables -D OUTPUT -o " + tapName + " -j " + ingress6,
		"iptables -X " + input4,
		"iptables -X " + egress4,
		"iptables -X " + ingress4,
		"ip6tables -X " + input6,
		"ip6tables -X " + egress6,
		"ip6tables -X " + ingress6,
	} {
		if !slices.Contains(cleanupStrings, want) {
			t.Errorf("missing cleanup command %q", want)
		}
	}
}

func TestConfigureIngressPublicIsEgressOnly(t *testing.T) {
	t.Parallel()

	cfg := &NetworkConfig{HostPort: 12345, GuestPort: 80}
	hostPort, err := configureIngress(cfg, types.NetworkPolicyPublic, 8787)
	if err != nil {
		t.Fatalf("configure public-only ingress: %v", err)
	}
	if hostPort != 0 || cfg.HostPort != 0 {
		t.Fatalf("public-only policy exposed host port: returned=%d config=%d", hostPort, cfg.HostPort)
	}
	if cfg.GuestPort != 8787 {
		t.Fatalf("guest port = %d, want 8787", cfg.GuestPort)
	}
	if cfg.DNATRuleAdded {
		t.Fatal("public-only policy installed DNAT")
	}
}

func TestApplyNetworkPolicyValidation(t *testing.T) {
	t.Parallel()

	var calls []string
	runner := func(name string, args ...string) error {
		calls = append(calls, name+" "+strings.Join(args, " "))
		return nil
	}

	cfg := &NetworkConfig{TAPName: "qm-tap0000001", GuestIP: "172.16.0.2"}
	if err := applyNetworkPolicyWithRunner(cfg, types.NetworkPolicyNone, runner); err != nil {
		t.Fatalf("empty policy: %v", err)
	}
	if len(calls) != 0 {
		t.Fatalf("empty policy ran firewall commands: %v", calls)
	}

	if err := applyNetworkPolicyWithRunner(cfg, types.NetworkPolicy("private"), runner); err == nil {
		t.Fatal("unsupported policy unexpectedly succeeded")
	}
	if len(calls) != 0 {
		t.Fatalf("invalid policy ran firewall commands: %v", calls)
	}

	if err := applyNetworkPolicyWithRunner(&NetworkConfig{TAPName: "bad tap/name", GuestIP: "172.16.0.2"}, types.NetworkPolicyPublic, runner); err == nil {
		t.Fatal("invalid TAP name unexpectedly succeeded")
	}
	if len(calls) != 0 {
		t.Fatalf("invalid TAP name ran firewall commands: %v", calls)
	}

	if err := applyNetworkPolicyWithRunner(&NetworkConfig{TAPName: "qm-tap0000001", GuestIP: "not-an-ip"}, types.NetworkPolicyPublic, runner); err == nil {
		t.Fatal("invalid guest IP unexpectedly succeeded")
	}
	if len(calls) != 0 {
		t.Fatalf("invalid guest IP ran firewall commands: %v", calls)
	}
}

func TestApplyPublicNetworkPolicyCleansUpOnFailure(t *testing.T) {
	t.Parallel()

	tapName := "qm-tap0000001"
	cfg := &NetworkConfig{TAPName: tapName, GuestIP: "172.16.0.2"}
	_, egress4, _, _, _, _ := networkPolicyChainNames(tapName)
	failingCommand := "iptables -A " + egress4 + " -d 169.254.0.0/16 -j DROP"
	var calls []string
	failureIndex := -1
	runner := func(name string, args ...string) error {
		call := name + " " + strings.Join(args, " ")
		calls = append(calls, call)
		if call == failingCommand {
			failureIndex = len(calls) - 1
			return errors.New("injected failure")
		}
		return nil
	}

	err := applyNetworkPolicyWithRunner(cfg, types.NetworkPolicyPublic, runner)
	if err == nil || !strings.Contains(err.Error(), "injected failure") {
		t.Fatalf("expected injected failure, got %v", err)
	}
	if failureIndex < 0 {
		t.Fatalf("failing command was not run: %v", calls)
	}
	cleanupAfterFailure := "iptables -X " + egress4
	if !slices.Contains(calls[failureIndex+1:], cleanupAfterFailure) {
		t.Fatalf("policy chains were not cleaned up after failure: %v", calls[failureIndex+1:])
	}
}
