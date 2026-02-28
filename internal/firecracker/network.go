package firecracker

import (
	"fmt"
	"hash/fnv"
	"net"
	"os/exec"
	"strings"
	"sync"
)

// NetworkConfig holds the networking state for a single VM.
type NetworkConfig struct {
	TAPName string // e.g., "fc-tap0"
	HostIP  string // e.g., "10.0.0.1"
	GuestIP string // e.g., "10.0.0.2"
	Mask    string // e.g., "255.255.255.252"
	CIDR    int    // /30

	// Port forwarding
	HostPort      int // host port mapped to guest
	GuestPort     int // guest port (typically 80)
	DNATRuleAdded bool
}

const tapPoolSize = 4_194_304 // 10.0.0.0/8 split into /30 blocks: 2^24 / 4

// DeterministicTAPBlock returns the TAP block index for a sandbox ID.
// The same sandbox always maps to the same block on every worker, enabling
// cross-worker snapshot restore without any coordination.
func DeterministicTAPBlock(sandboxID string) uint32 {
	h := fnv.New32a()
	h.Write([]byte(sandboxID))
	return h.Sum32() % tapPoolSize
}

// DeterministicTAPName returns the TAP device name for a sandbox ID.
func DeterministicTAPName(sandboxID string) string {
	return fmt.Sprintf("fc-tap%d", DeterministicTAPBlock(sandboxID))
}

// SubnetAllocator manages /30 subnet allocation from a 10.0.0.0/8 pool.
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
// Returns tapName, hostIP, guestIP, mask.
func (a *SubnetAllocator) Allocate() (*NetworkConfig, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	// Find next free /30 block
	block := a.next
	for a.used[block] {
		block++
		if block >= tapPoolSize { // 10.0.0.0/8 has 4,194,304 /30 blocks
			return nil, fmt.Errorf("subnet pool exhausted")
		}
	}
	a.used[block] = true
	a.next = block + 1

	hostIP, guestIP := blockToIPs(block)

	tapName := fmt.Sprintf("fc-tap%d", block)

	return &NetworkConfig{
		TAPName: tapName,
		HostIP:  hostIP,
		GuestIP: guestIP,
		Mask:    "255.255.255.252",
		CIDR:    30,
	}, nil
}

// AllocateSpecific reserves a specific TAP name/subnet block.
// Used during snapshot restore where the TAP name is baked into the vmstate.
func (a *SubnetAllocator) AllocateSpecific(tapName string) (*NetworkConfig, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	var block uint32
	if _, err := fmt.Sscanf(tapName, "fc-tap%d", &block); err != nil {
		return nil, fmt.Errorf("parse tap name %q: %w", tapName, err)
	}
	if a.used[block] {
		return nil, fmt.Errorf("tap %s already in use", tapName)
	}
	a.used[block] = true

	hostIP, guestIP := blockToIPs(block)
	return &NetworkConfig{
		TAPName: tapName,
		HostIP:  hostIP,
		GuestIP: guestIP,
		Mask:    "255.255.255.252",
		CIDR:    30,
	}, nil
}

// CanAllocateSpecific reports whether a TAP block is currently free.
// Read-only: does not reserve anything.
func (a *SubnetAllocator) CanAllocateSpecific(tapName string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	var block uint32
	if _, err := fmt.Sscanf(tapName, "fc-tap%d", &block); err != nil {
		return false
	}
	return !a.used[block]
}

// blockToIPs converts a /30 block index to host and guest IP strings.
// IP layout: 10.{b1}.{b2}.{b3} where base = block*4 encodes the last 24 bits.
// Each /30: .0=network, .1=host, .2=guest, .3=broadcast.
func blockToIPs(block uint32) (hostIP, guestIP string) {
	base := block * 4
	b1 := byte(base >> 16)
	b2 := byte(base >> 8)
	b3 := byte(base)
	hostIP = fmt.Sprintf("10.%d.%d.%d", b1, b2, b3+1)
	guestIP = fmt.Sprintf("10.%d.%d.%d", b1, b2, b3+2)
	return
}

// Release returns a /30 block to the pool.
func (a *SubnetAllocator) Release(tapName string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	// Extract block number from tap name
	var block uint32
	if _, err := fmt.Sscanf(tapName, "fc-tap%d", &block); err != nil {
		return
	}
	delete(a.used, block)
}

// CreateTAP creates a TAP device and configures it with the host IP.
func CreateTAP(cfg *NetworkConfig) error {
	// Create TAP device
	if err := run("ip", "tuntap", "add", "dev", cfg.TAPName, "mode", "tap"); err != nil {
		return fmt.Errorf("create tap %s: %w", cfg.TAPName, err)
	}

	// Assign host IP
	addr := fmt.Sprintf("%s/%d", cfg.HostIP, cfg.CIDR)
	if err := run("ip", "addr", "add", addr, "dev", cfg.TAPName); err != nil {
		DeleteTAP(cfg.TAPName)
		return fmt.Errorf("assign ip to %s: %w", cfg.TAPName, err)
	}

	// Bring up
	if err := run("ip", "link", "set", cfg.TAPName, "up"); err != nil {
		DeleteTAP(cfg.TAPName)
		return fmt.Errorf("bring up %s: %w", cfg.TAPName, err)
	}

	return nil
}

// DeleteTAP removes a TAP device.
func DeleteTAP(tapName string) {
	_ = run("ip", "link", "del", tapName)
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

	// Also add for locally-generated traffic (connections from the host itself)
	err = run("iptables", "-t", "nat", "-A", "OUTPUT",
		"-p", "tcp", "--dport", fmt.Sprintf("%d", cfg.HostPort),
		"-j", "DNAT", "--to-destination",
		fmt.Sprintf("%s:%d", cfg.GuestIP, cfg.GuestPort))
	if err != nil {
		// Non-fatal — PREROUTING is the important one
		return nil
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

// EnableForwarding enables IPv4 forwarding and masquerading for the VM subnet.
// Call once at startup.
func EnableForwarding() error {
	// Enable IP forwarding
	if err := run("sysctl", "-w", "net.ipv4.ip_forward=1"); err != nil {
		return fmt.Errorf("enable ip_forward: %w", err)
	}

	// Allow routing packets with 127.0.0.0/8 source through non-loopback interfaces.
	// Required for DNAT from localhost:PORT → guest VM IP to work.
	if err := run("sysctl", "-w", "net.ipv4.conf.all.route_localnet=1"); err != nil {
		return fmt.Errorf("enable route_localnet: %w", err)
	}

	// Add masquerade rule for VM subnet (idempotent — check if exists first)
	out, _ := exec.Command("iptables", "-t", "nat", "-S", "POSTROUTING").CombinedOutput()
	outRules := string(out)
	if !strings.Contains(outRules, "10.0.0.0/8") {
		// Detect the default outgoing interface
		outIface := detectDefaultInterface()
		if outIface != "" {
			_ = run("iptables", "-t", "nat", "-A", "POSTROUTING",
				"-s", "10.0.0.0/8", "-o", outIface,
				"-j", "MASQUERADE")
		} else {
			// Fallback: masquerade on all interfaces except TAPs
			_ = run("iptables", "-t", "nat", "-A", "POSTROUTING",
				"-s", "10.0.0.0/8", "!", "-o", "fc-tap+",
				"-j", "MASQUERADE")
		}
	}

	// Masquerade for DNAT'd traffic from the host to VMs (e.g. localhost:PORT → guest:80).
	// Without this, packets arrive at the guest with src=127.0.0.1, and replies go nowhere.
	// This rewrites src to the host's TAP IP so the guest replies back through the TAP.
	if !strings.Contains(outRules, "10.0.0.0/8 -j MASQUERADE") {
		_ = run("iptables", "-t", "nat", "-A", "POSTROUTING",
			"-d", "10.0.0.0/8",
			"-j", "MASQUERADE")
	}

	return nil
}

// detectDefaultInterface returns the name of the default outgoing network interface.
func detectDefaultInterface() string {
	out, err := exec.Command("ip", "route", "show", "default").CombinedOutput()
	if err != nil {
		return ""
	}
	// Parse "default via X.X.X.X dev <iface> ..."
	fields := strings.Fields(string(out))
	for i, f := range fields {
		if f == "dev" && i+1 < len(fields) {
			return fields[i+1]
		}
	}
	return ""
}

// FindFreePort finds a free TCP port on the host.
func FindFreePort() (int, error) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := lis.Addr().(*net.TCPAddr).Port
	lis.Close()
	return port, nil
}

// run executes a command and returns an error with stderr if it fails.
func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w (%s)", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
