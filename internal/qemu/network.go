package qemu

import (
	"fmt"
	"net"
	"os/exec"
	"strings"
	"sync"

	"github.com/opensandbox/opensandbox/pkg/types"
)

// NetworkConfig holds the networking state for a single VM.
type NetworkConfig struct {
	TAPName string // e.g., "qm-tap0000000"
	HostIP  string // e.g., "172.16.0.1"
	GuestIP string // e.g., "172.16.0.2"
	Mask    string // e.g., "255.255.255.252"
	CIDR    int    // /30

	// Port forwarding
	HostPort      int // host port mapped to guest
	GuestPort     int // guest port (typically 80)
	DNATRuleAdded bool
}

// SubnetAllocator manages /30 subnet allocation from a 172.16.0.0/16 pool.
// Each VM gets a /30: host IP (.1) and guest IP (.2), with .0 as network and .3 as broadcast.
type SubnetAllocator struct {
	mu   sync.Mutex
	next uint32 // next /30 block index (0, 1, 2, ...)
	used map[uint32]bool
}

// NewSubnetAllocator creates a new subnet allocator.
func NewSubnetAllocator() *SubnetAllocator {
	return &SubnetAllocator{
		used: make(map[uint32]bool),
	}
}

// Allocate returns a new /30 subnet for a VM.
func (a *SubnetAllocator) Allocate() (*NetworkConfig, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	block := a.next
	start := block
	for a.used[block] {
		block++
		if block > 16383 {
			block = 0 // wrap around to recycle released blocks
		}
		if block == start {
			return nil, fmt.Errorf("subnet pool exhausted (%d in use)", len(a.used))
		}
	}
	a.used[block] = true
	a.next = block + 1
	if a.next > 16383 {
		a.next = 0
	}

	base := block * 4
	b2 := byte(base >> 8)
	b3 := byte(base & 0xFF)

	hostIP := fmt.Sprintf("172.16.%d.%d", b2, b3+1)
	guestIP := fmt.Sprintf("172.16.%d.%d", b2, b3+2)

	tapName := fmt.Sprintf("qm-tap%07d", block)

	return &NetworkConfig{
		TAPName: tapName,
		HostIP:  hostIP,
		GuestIP: guestIP,
		Mask:    "255.255.255.252",
		CIDR:    30,
	}, nil
}

// AllocateSpecific reserves a specific TAP name/subnet block.
// Used during snapshot restore where the TAP name is baked into the migration state.
func (a *SubnetAllocator) AllocateSpecific(tapName string) (*NetworkConfig, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	var block uint32
	if _, err := fmt.Sscanf(tapName, "qm-tap%d", &block); err != nil {
		return nil, fmt.Errorf("parse tap name %q: %w", tapName, err)
	}
	if a.used[block] {
		return nil, fmt.Errorf("tap %s already in use", tapName)
	}
	a.used[block] = true

	base := block * 4
	b2 := byte(base >> 8)
	b3 := byte(base & 0xFF)

	return &NetworkConfig{
		TAPName: tapName,
		HostIP:  fmt.Sprintf("172.16.%d.%d", b2, b3+1),
		GuestIP: fmt.Sprintf("172.16.%d.%d", b2, b3+2),
		Mask:    "255.255.255.252",
		CIDR:    30,
	}, nil
}

// Release returns a /30 block to the pool.
func (a *SubnetAllocator) Release(tapName string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	var block uint32
	if _, err := fmt.Sscanf(tapName, "qm-tap%d", &block); err != nil {
		return
	}
	delete(a.used, block)
}

// CreateTAP creates a TAP device, configures it with the host IP, and applies
// any host-enforced network policy before the guest can start.
func CreateTAP(cfg *NetworkConfig, policy types.NetworkPolicy) error {
	if err := run("ip", "tuntap", "add", "dev", cfg.TAPName, "mode", "tap"); err != nil {
		return fmt.Errorf("create tap %s: %w", cfg.TAPName, err)
	}

	addr := fmt.Sprintf("%s/%d", cfg.HostIP, cfg.CIDR)
	if err := run("ip", "addr", "add", addr, "dev", cfg.TAPName); err != nil {
		DeleteTAP(cfg.TAPName)
		return fmt.Errorf("assign ip to %s: %w", cfg.TAPName, err)
	}

	if err := run("ip", "link", "set", cfg.TAPName, "up"); err != nil {
		DeleteTAP(cfg.TAPName)
		return fmt.Errorf("bring up %s: %w", cfg.TAPName, err)
	}

	// Apply network rate limiting: 500 Mbps bandwidth cap per VM.
	// Prevents noisy-neighbor abuse without throttling normal sandbox use.
	// Pre-fix the cap was 50 Mbps which was tight enough to noticeably slow
	// npm install, docker pull, model downloads, and large uploads — all
	// real-world sandbox workloads. 500 Mbps gives sandboxes a credible
	// link speed while still bounding aggregate worker NIC pressure.
	applyRateLimit(cfg.TAPName)

	if err := applyNetworkPolicy(cfg, policy); err != nil {
		DeleteTAP(cfg.TAPName)
		return fmt.Errorf("apply network policy %q to %s: %w", policy, cfg.TAPName, err)
	}

	return nil
}

// applyRateLimit sets tc rate limiting on a TAP device.
// Token bucket filter: 500 Mbps sustained, 10 MB burst, 50 ms latency.
// Burst is sized so a typical TLS handshake + first request fits in one shot
// rather than being shaped from packet 1.
func applyRateLimit(tapName string) {
	_ = run("tc", "qdisc", "add", "dev", tapName, "root", "tbf",
		"rate", "500mbit", "burst", "10mb", "latency", "50ms")
}

// DeleteTAP removes a TAP device, its tc qdisc, and any per-TAP firewall
// policy. Firewall cleanup is unconditional so a recycled TAP name cannot
// inherit rules from an interrupted sandbox lifecycle.
func DeleteTAP(tapName string) {
	cleanupNetworkPolicy(tapName)
	_ = run("tc", "qdisc", "del", "dev", tapName, "root")
	_ = run("ip", "link", "del", tapName)
}

type networkCommand struct {
	name string
	args []string
}

type networkCommandRunner func(name string, args ...string) error

var publicBlockedIPv4CIDRs = []string{
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.0.2.0/24",
	"192.88.99.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"198.51.100.0/24",
	"203.0.113.0/24",
	"224.0.0.0/4",
	"240.0.0.0/4",
}

func networkPolicyChainNames(tapName string) (input4, egress4, ingress4, input6, egress6, ingress6 string) {
	return "OCPI-" + tapName, "OCPE-" + tapName, "OCPN-" + tapName,
		"OC6I-" + tapName, "OC6E-" + tapName, "OC6N-" + tapName
}

func validateTAPName(tapName string) error {
	if tapName == "" || len(tapName) > 15 {
		return fmt.Errorf("invalid TAP name %q", tapName)
	}
	for _, r := range tapName {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' || r == '.' {
			continue
		}
		return fmt.Errorf("invalid TAP name %q", tapName)
	}
	return nil
}

// publicNetworkPolicyCommands returns the fail-closed firewall program for a
// public-only sandbox. The per-TAP jumps are inserted ahead of the worker's
// broad 172.16/16 forwarding rules. INPUT denies guest-to-worker access,
// including the metadata DNAT target. The egress chain rejects spoofed source
// addresses and non-public IPv4 destinations before permitting ordinary public
// IPv4. The separate ingress chain permits established replies but rejects new
// connections from forwarded and host-originated traffic (including a stale
// local DNAT rule). IPv6 is denied because the worker does not currently
// provide a public-IPv6 route with an equivalent allow contract.
func publicNetworkPolicyCommands(cfg *NetworkConfig) []networkCommand {
	tapName := cfg.TAPName
	input4, egress4, ingress4, input6, egress6, ingress6 := networkPolicyChainNames(tapName)
	commands := []networkCommand{
		{name: "iptables", args: []string{"-N", input4}},
		{name: "iptables", args: []string{"-A", input4, "-j", "DROP"}},
		{name: "iptables", args: []string{"-N", egress4}},
		{name: "iptables", args: []string{"-A", egress4, "!", "-s", cfg.GuestIP + "/32", "-j", "DROP"}},
	}
	for _, cidr := range publicBlockedIPv4CIDRs {
		commands = append(commands, networkCommand{
			name: "iptables",
			args: []string{"-A", egress4, "-d", cidr, "-j", "DROP"},
		})
	}
	commands = append(commands,
		networkCommand{name: "iptables", args: []string{"-A", egress4, "-j", "ACCEPT"}},
		networkCommand{name: "iptables", args: []string{"-N", ingress4}},
		networkCommand{name: "iptables", args: []string{"-A", ingress4, "-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "-j", "ACCEPT"}},
		networkCommand{name: "iptables", args: []string{"-A", ingress4, "-j", "DROP"}},
		networkCommand{name: "ip6tables", args: []string{"-N", input6}},
		networkCommand{name: "ip6tables", args: []string{"-A", input6, "-j", "DROP"}},
		networkCommand{name: "ip6tables", args: []string{"-N", egress6}},
		networkCommand{name: "ip6tables", args: []string{"-A", egress6, "-j", "DROP"}},
		networkCommand{name: "ip6tables", args: []string{"-N", ingress6}},
		networkCommand{name: "ip6tables", args: []string{"-A", ingress6, "-j", "DROP"}},
		// Install jumps only after every chain has been populated. CreateTAP
		// fails and deletes the TAP if any command above or below fails.
		networkCommand{name: "iptables", args: []string{"-I", "INPUT", "1", "-i", tapName, "-j", input4}},
		networkCommand{name: "iptables", args: []string{"-I", "FORWARD", "1", "-i", tapName, "-j", egress4}},
		networkCommand{name: "iptables", args: []string{"-I", "FORWARD", "1", "-o", tapName, "-j", ingress4}},
		networkCommand{name: "iptables", args: []string{"-I", "OUTPUT", "1", "-o", tapName, "-j", ingress4}},
		networkCommand{name: "ip6tables", args: []string{"-I", "INPUT", "1", "-i", tapName, "-j", input6}},
		networkCommand{name: "ip6tables", args: []string{"-I", "FORWARD", "1", "-i", tapName, "-j", egress6}},
		networkCommand{name: "ip6tables", args: []string{"-I", "FORWARD", "1", "-o", tapName, "-j", ingress6}},
		networkCommand{name: "ip6tables", args: []string{"-I", "OUTPUT", "1", "-o", tapName, "-j", ingress6}},
	)
	return commands
}

func networkPolicyCleanupCommands(tapName string) []networkCommand {
	input4, egress4, ingress4, input6, egress6, ingress6 := networkPolicyChainNames(tapName)
	return []networkCommand{
		{name: "iptables", args: []string{"-D", "INPUT", "-i", tapName, "-j", input4}},
		{name: "iptables", args: []string{"-D", "FORWARD", "-i", tapName, "-j", egress4}},
		{name: "iptables", args: []string{"-D", "FORWARD", "-o", tapName, "-j", ingress4}},
		{name: "iptables", args: []string{"-D", "OUTPUT", "-o", tapName, "-j", ingress4}},
		{name: "iptables", args: []string{"-F", input4}},
		{name: "iptables", args: []string{"-X", input4}},
		{name: "iptables", args: []string{"-F", egress4}},
		{name: "iptables", args: []string{"-X", egress4}},
		{name: "iptables", args: []string{"-F", ingress4}},
		{name: "iptables", args: []string{"-X", ingress4}},
		{name: "ip6tables", args: []string{"-D", "INPUT", "-i", tapName, "-j", input6}},
		{name: "ip6tables", args: []string{"-D", "FORWARD", "-i", tapName, "-j", egress6}},
		{name: "ip6tables", args: []string{"-D", "FORWARD", "-o", tapName, "-j", ingress6}},
		{name: "ip6tables", args: []string{"-D", "OUTPUT", "-o", tapName, "-j", ingress6}},
		{name: "ip6tables", args: []string{"-F", input6}},
		{name: "ip6tables", args: []string{"-X", input6}},
		{name: "ip6tables", args: []string{"-F", egress6}},
		{name: "ip6tables", args: []string{"-X", egress6}},
		{name: "ip6tables", args: []string{"-F", ingress6}},
		{name: "ip6tables", args: []string{"-X", ingress6}},
	}
}

func applyNetworkPolicy(cfg *NetworkConfig, policy types.NetworkPolicy) error {
	return applyNetworkPolicyWithRunner(cfg, policy, run)
}

func applyNetworkPolicyWithRunner(cfg *NetworkConfig, policy types.NetworkPolicy, runner networkCommandRunner) error {
	if cfg == nil {
		return fmt.Errorf("network config is required")
	}
	if err := validateTAPName(cfg.TAPName); err != nil {
		return err
	}
	if err := policy.Validate(); err != nil {
		return err
	}
	if policy == types.NetworkPolicyNone {
		return nil
	}
	if ip := net.ParseIP(cfg.GuestIP); ip == nil || ip.To4() == nil {
		return fmt.Errorf("invalid guest IPv4 address %q", cfg.GuestIP)
	}

	// An interrupted prior lifecycle may have left per-TAP chains behind. Best
	// effort cleanup makes setup idempotent; any residue that cannot be removed
	// makes a subsequent -N/-I command fail and the sandbox creation fails closed.
	cleanupNetworkPolicyWithRunner(cfg.TAPName, runner)
	for _, command := range publicNetworkPolicyCommands(cfg) {
		if err := runner(command.name, command.args...); err != nil {
			cleanupNetworkPolicyWithRunner(cfg.TAPName, runner)
			return fmt.Errorf("%s %s: %w", command.name, strings.Join(command.args, " "), err)
		}
	}
	return nil
}

func cleanupNetworkPolicy(tapName string) {
	if validateTAPName(tapName) != nil {
		return
	}
	cleanupNetworkPolicyWithRunner(tapName, run)
}

func cleanupNetworkPolicyWithRunner(tapName string, runner networkCommandRunner) {
	for _, command := range networkPolicyCleanupCommands(tapName) {
		_ = runner(command.name, command.args...)
	}
}

// AddDNAT adds an iptables DNAT rule: hostPort → guestIP:guestPort.
func AddDNAT(cfg *NetworkConfig) error {
	if cfg.HostPort == 0 || cfg.GuestPort == 0 {
		return nil
	}
	err := run("iptables", "-t", "nat", "-A", "PREROUTING",
		"-p", "tcp", "--dport", fmt.Sprintf("%d", cfg.HostPort),
		"-j", "DNAT", "--to-destination",
		fmt.Sprintf("%s:%d", cfg.GuestIP, cfg.GuestPort))
	if err != nil {
		return fmt.Errorf("add DNAT: %w", err)
	}

	// Also add for locally-generated traffic
	if err := run("iptables", "-t", "nat", "-A", "OUTPUT",
		"-p", "tcp", "--dport", fmt.Sprintf("%d", cfg.HostPort),
		"-j", "DNAT", "--to-destination",
		fmt.Sprintf("%s:%d", cfg.GuestIP, cfg.GuestPort)); err != nil {
		// Roll back the PREROUTING rule we already added
		_ = run("iptables", "-t", "nat", "-D", "PREROUTING",
			"-p", "tcp", "--dport", fmt.Sprintf("%d", cfg.HostPort),
			"-j", "DNAT", "--to-destination",
			fmt.Sprintf("%s:%d", cfg.GuestIP, cfg.GuestPort))
		return fmt.Errorf("add DNAT OUTPUT: %w", err)
	}

	cfg.DNATRuleAdded = true
	return nil
}

// RemoveDNAT removes the iptables DNAT rules.
func RemoveDNAT(cfg *NetworkConfig) {
	if !cfg.DNATRuleAdded {
		return
	}
	_ = run("iptables", "-t", "nat", "-D", "PREROUTING",
		"-p", "tcp", "--dport", fmt.Sprintf("%d", cfg.HostPort),
		"-j", "DNAT", "--to-destination",
		fmt.Sprintf("%s:%d", cfg.GuestIP, cfg.GuestPort))
	_ = run("iptables", "-t", "nat", "-D", "OUTPUT",
		"-p", "tcp", "--dport", fmt.Sprintf("%d", cfg.HostPort),
		"-j", "DNAT", "--to-destination",
		fmt.Sprintf("%s:%d", cfg.GuestIP, cfg.GuestPort))
}

// configureIngress exposes the guest port for unrestricted sandboxes. A
// public-only sandbox is intentionally egress-only: it gets neither a host
// port allocation nor DNAT rules, and its FORWARD policy independently drops
// new traffic headed to the TAP as defense in depth.
func configureIngress(cfg *NetworkConfig, policy types.NetworkPolicy, guestPort int) (int, error) {
	if err := policy.Validate(); err != nil {
		return 0, err
	}
	cfg.GuestPort = guestPort
	if policy == types.NetworkPolicyPublic {
		cfg.HostPort = 0
		return 0, nil
	}

	hostPort, err := FindFreePort()
	if err != nil {
		return 0, fmt.Errorf("find free port: %w", err)
	}
	cfg.HostPort = hostPort
	if err := AddDNAT(cfg); err != nil {
		return 0, err
	}
	return hostPort, nil
}

// AddMetadataDNAT adds an iptables rule to redirect 169.254.169.254:80 from a VM's TAP
// to the host metadata server on port 8888.
func AddMetadataDNAT(tapName, hostIP string) error {
	err := run("iptables", "-t", "nat", "-A", "PREROUTING",
		"-i", tapName,
		"-d", "169.254.169.254",
		"-p", "tcp", "--dport", "80",
		"-j", "DNAT", "--to-destination", hostIP+":8888")
	if err != nil {
		return fmt.Errorf("add metadata DNAT for %s: %w", tapName, err)
	}
	return nil
}

// RemoveMetadataDNAT removes the metadata DNAT rule for a TAP device.
func RemoveMetadataDNAT(tapName, hostIP string) {
	_ = run("iptables", "-t", "nat", "-D", "PREROUTING",
		"-i", tapName,
		"-d", "169.254.169.254",
		"-p", "tcp", "--dport", "80",
		"-j", "DNAT", "--to-destination", hostIP+":8888")
}

// EnableForwarding enables IPv4 forwarding and masquerading for the VM subnet.
func EnableForwarding() error {
	if err := run("sysctl", "-w", "net.ipv4.ip_forward=1"); err != nil {
		return fmt.Errorf("enable ip_forward: %w", err)
	}

	if err := run("sysctl", "-w", "net.ipv4.conf.all.route_localnet=1"); err != nil {
		return fmt.Errorf("enable route_localnet: %w", err)
	}

	out, _ := exec.Command("iptables", "-t", "nat", "-S", "POSTROUTING").CombinedOutput()
	outRules := string(out)
	if !strings.Contains(outRules, "172.16.0.0/16") {
		outIface := detectDefaultInterface()
		if outIface != "" {
			_ = run("iptables", "-t", "nat", "-A", "POSTROUTING",
				"-s", "172.16.0.0/16", "-o", outIface,
				"-j", "MASQUERADE")
		} else {
			_ = run("iptables", "-t", "nat", "-A", "POSTROUTING",
				"-s", "172.16.0.0/16", "!", "-o", "qm-tap+",
				"-j", "MASQUERADE")
		}
	}

	if !strings.Contains(outRules, "172.16.0.0/16 -j MASQUERADE") {
		_ = run("iptables", "-t", "nat", "-A", "POSTROUTING",
			"-d", "172.16.0.0/16",
			"-j", "MASQUERADE")
	}

	fwdOut, _ := exec.Command("iptables", "-S", "FORWARD").CombinedOutput()
	fwdRules := string(fwdOut)
	if !strings.Contains(fwdRules, "172.16.0.0/16 -j ACCEPT") {
		_ = run("iptables", "-I", "FORWARD",
			"-s", "172.16.0.0/16",
			"-j", "ACCEPT")
		_ = run("iptables", "-I", "FORWARD",
			"-d", "172.16.0.0/16",
			"-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED",
			"-j", "ACCEPT")
	}

	return nil
}

func detectDefaultInterface() string {
	out, err := exec.Command("ip", "route", "show", "default").CombinedOutput()
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(out))
	for i, f := range fields {
		if f == "dev" && i+1 < len(fields) {
			return fields[i+1]
		}
	}
	return ""
}

// FindFreePort finds a free TCP port on the host.
// Note: This has a TOCTOU race — two concurrent calls can get the same port.
// In practice this is acceptable because the port is used for DNAT rules (not
// a real listener), so collisions are extremely unlikely and would only occur
// if two sandboxes are created in the same microsecond window.
func FindFreePort() (int, error) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := lis.Addr().(*net.TCPAddr).Port
	lis.Close()
	return port, nil
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w (%s)", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
