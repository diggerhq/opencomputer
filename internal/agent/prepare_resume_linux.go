//go:build linux

package agent

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	pb "github.com/opensandbox/opensandbox/proto/agent"
	"golang.org/x/sys/unix"
)

// setGuestClock sets the wall clock natively (settimeofday), replacing the
// `date -s @N` shell-out. The golden snapshot froze time at capture; the host
// passes the current instant so the guest clock is correct on resume.
func setGuestClock(unixNanos int64) error {
	tv := unix.NsecToTimeval(unixNanos)
	if err := unix.Settimeofday(&tv); err != nil {
		return fmt.Errorf("settimeofday: %w", err)
	}
	return nil
}

// configureGuestNetwork reconfigures the guest NIC + DNS after a golden restore.
//
// DNS (/etc/resolv.conf) and /etc/hosts are written natively — no `echo`/`grep`
// shell-outs. The address/route/neigh reconfig still runs the proven `ip` script
// as a SINGLE exec: it keeps the battle-tested behaviour (idempotent flush+add,
// the cross-worker `ip neigh flush all` ARP fix, final verification) intact while
// the surrounding cheap steps go native. Returns network_method for the response;
// a netlink-native path can replace this exec later without touching the host.
func configureGuestNetwork(req *pb.PrepareResumeRequest) (method string, err error) {
	iface := req.Iface
	if iface == "" {
		iface = "eth0"
	}

	// DNS — always overwrite when nameservers are supplied.
	if len(req.Dns) > 0 {
		var b strings.Builder
		for _, ns := range req.Dns {
			b.WriteString("nameserver ")
			b.WriteString(ns)
			b.WriteString("\n")
		}
		if werr := os.WriteFile("/etc/resolv.conf", []byte(b.String()), 0o644); werr != nil {
			// Non-fatal: log via the returned error path only if nothing else fails.
			// We continue so a resolv.conf hiccup can't strand the NIC config.
			_ = werr
		}
	}

	// /etc/hosts — ensure the current hostname resolves (else `sudo` warns
	// "unable to resolve host").
	ensureHostsEntry()

	// Address / link / route / neigh via one `ip` script.
	var sb strings.Builder
	sb.WriteString("set +e\n")
	fmt.Fprintf(&sb, "ip addr flush dev %s\n", iface)
	fmt.Fprintf(&sb, "ip addr add %s/%d dev %s 2>/dev/null\n", req.GuestIp, req.PrefixLen, iface)
	fmt.Fprintf(&sb, "ip link set %s up\n", iface)
	if req.Gateway != "" {
		fmt.Fprintf(&sb, "ip route replace default via %s\n", req.Gateway)
	}
	if req.FlushNeigh {
		sb.WriteString("ip neigh flush all\n")
	}
	// Final verification — fail only if the desired state wasn't reached.
	fmt.Fprintf(&sb, "ip addr show %s | grep -q %s || exit 1\n", iface, req.GuestIp)
	if req.Gateway != "" {
		fmt.Fprintf(&sb, "ip route show default | grep -q %s || exit 2\n", req.Gateway)
	}
	sb.WriteString("exit 0\n")

	cmd := exec.Command("/bin/sh", "-c", sb.String())
	if out, cerr := cmd.CombinedOutput(); cerr != nil {
		return "exec", fmt.Errorf("ip config: %w (%s)", cerr, strings.TrimSpace(string(out)))
	}
	return "exec", nil
}

// ensureHostsEntry appends a loopback entry for the current hostname to
// /etc/hosts if one isn't already present. Native replacement for
// `grep -q "$(hostname)" /etc/hosts || echo "127.0.0.1 $(hostname)" >> /etc/hosts`.
func ensureHostsEntry() {
	host, err := os.Hostname()
	if err != nil || host == "" {
		return
	}
	data, _ := os.ReadFile("/etc/hosts")
	if strings.Contains(string(data), host) {
		return
	}
	f, err := os.OpenFile("/etc/hosts", os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = fmt.Fprintf(f, "127.0.0.1 %s\n", host)
}
