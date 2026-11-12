// Caller identity: which caller a connection on the API socket comes from.
// SO_PEERCRED gives the peer's pid; /proc/<pid>/cgroup gives its cgroup
// path, whose first `sp-runner-<id>.service` element names the caller <id>.
// The first, not the last: a process can create cgroups below its own unit
// and name them as it likes, but not above it.
//
// This is routing, not isolation: the computer is the trust boundary.
// Sessions that share a uid share a systemd user manager, and a process can
// move itself into a sibling unit's cgroup. Do not co-host mutually
// untrusted tenants on one computer.
//
// -identity=single is for a computer that runs one session outside systemd:
// every connection is the caller singleCaller, which the binder binds.
//
// Invariant: resolved once per connection, when it is accepted
// (http.Server.ConnContext), never per request; an empty caller means "not a
// session" and is refused at once.
package main

import (
	"bufio"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Resolver maps an accepted API connection to its caller ("" if none).
// Tests inject their own; a deployment uses peerResolver or singleResolver.
type Resolver func(c net.Conn) string

// callerFromCgroup reads /proc/<pid>/cgroup content. The cgroup v2 line
// ("0::/...") wins; on a hybrid host any line is accepted.
func callerFromCgroup(r io.Reader) string {
	var v2, other string
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := sc.Text()
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		u := firstRunner(parts[2])
		if u == "" {
			continue
		}
		if parts[0] == "0" && parts[1] == "" {
			v2 = u
		} else if other == "" {
			other = u
		}
	}
	if v2 != "" {
		return v2
	}
	return other
}

// firstRunner is the caller named by the first runner unit in a cgroup path.
func firstRunner(path string) string {
	for elem := range strings.SplitSeq(path, "/") {
		if c := callerOfUnit(elem); c != "" {
			return c
		}
	}
	return ""
}

// callerOfUnit: sp-runner-<id>.service → <id>, when <id> is a caller id.
func callerOfUnit(unit string) string {
	id, ok := strings.CutPrefix(unit, "sp-runner-")
	if !ok {
		return ""
	}
	if id, ok = strings.CutSuffix(id, ".service"); !ok || !isID(id) {
		return ""
	}
	return id
}

// callerOfPid reads <procRoot>/<pid>/cgroup.
func callerOfPid(procRoot string, pid int) string {
	f, err := os.Open(filepath.Join(procRoot, strconv.Itoa(pid), "cgroup"))
	if err != nil {
		return ""
	}
	defer f.Close()
	return callerFromCgroup(f)
}

// singleCaller is every connection's caller under -identity=single.
const singleCaller = "single"

func singleResolver(net.Conn) string { return singleCaller }

// peerResolver is the cgroup Resolver: SO_PEERCRED pid → cgroup → caller.
func peerResolver(procRoot string) Resolver {
	return func(c net.Conn) string {
		pid, ok := peerPid(c)
		if !ok {
			return ""
		}
		return callerOfPid(procRoot, pid)
	}
}
