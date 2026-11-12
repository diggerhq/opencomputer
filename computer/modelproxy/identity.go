// Caller identity: which runner unit a connection on the API socket comes
// from. SO_PEERCRED gives the peer's pid; /proc/<pid>/cgroup gives its cgroup
// path, whose last `sp-runner-*.service` element is the unit. This is routing,
// not isolation: sessions that share a uid can forge unit names.
//
// -identity=single is for a computer that runs one session outside systemd:
// every caller is the unit singleUnit, which the host binds.
//
// Invariant: resolved once per connection (http.Server.ConnContext), never
// per request; an empty unit means "not a runner" and is refused at once.
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

// Resolver maps an accepted API connection to its runner unit ("" if none).
// Tests inject their own; a deployment uses peerResolver or singleResolver.
type Resolver func(c net.Conn) string

// unitFromCgroup returns the last path element matching sp-runner-*.service in
// /proc/<pid>/cgroup content. The cgroup v2 line ("0::/...") wins; on a
// hybrid host any line is accepted.
func unitFromCgroup(r io.Reader) string {
	var v2, other string
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := sc.Text()
		parts := strings.SplitN(line, ":", 3)
		if len(parts) != 3 {
			continue
		}
		u := lastRunnerUnit(parts[2])
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

func lastRunnerUnit(path string) string {
	elems := strings.Split(path, "/")
	for i := len(elems) - 1; i >= 0; i-- {
		if isRunnerUnit(elems[i]) {
			return elems[i]
		}
	}
	return ""
}

func isRunnerUnit(s string) bool {
	const pre, suf = "sp-runner-", ".service"
	if len(s) <= len(pre)+len(suf) || !strings.HasPrefix(s, pre) || !strings.HasSuffix(s, suf) {
		return false
	}
	return !strings.ContainsAny(s, "/ \t\n")
}

// unitOfPid reads <procRoot>/<pid>/cgroup.
func unitOfPid(procRoot string, pid int) string {
	f, err := os.Open(filepath.Join(procRoot, strconv.Itoa(pid), "cgroup"))
	if err != nil {
		return ""
	}
	defer f.Close()
	return unitFromCgroup(f)
}

// singleUnit is every caller's unit under -identity=single.
const singleUnit = "sp-runner-single.service"

func singleResolver(net.Conn) string { return singleUnit }

// peerResolver is the cgroup Resolver: SO_PEERCRED pid → cgroup → unit.
func peerResolver(procRoot string) Resolver {
	return func(c net.Conn) string {
		pid, ok := peerPid(c)
		if !ok {
			return ""
		}
		return unitOfPid(procRoot, pid)
	}
}
