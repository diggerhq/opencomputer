// Caller identity: which caller a connection on the API socket comes from.
// SO_PEERCRED gives the peer's pid and uid; /proc/<pid>/cgroup gives its
// cgroup path. The caller is <id> when the path is, from its root,
//
//	slices and user managers / slack-presence-runners.slice / sp-runner-<id>.service [/ anything]
//
// Anchored, not "contains": a session owns the cgroup subtree below its unit
// (a container's is delegated to it) and can create cgroups of any name
// there, but none above or beside its unit. So the element right below the
// runners' slice is read, nothing after it, and nothing but slices and
// `user@<uid>.service` may come before the slice.
//
// With -caller-uid, a peer of any other uid is no caller: in a session's
// container every other uid is one of its subordinate ids (its root, for
// one), and those are not the session. The root of a container the session
// nests as itself is that uid again, the session's own (1500), and is the
// session: the uid tells a session's user from the rest, never one session
// from another, which is the cgroup's part.
//
// Where sessions run as plain units of one user (no containers), this is
// routing, not isolation: they share a systemd user manager, and a process
// can move itself into a sibling unit's cgroup. A container cannot: it sees
// only its own subtree of the hierarchy.
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
	"regexp"
	"strconv"
	"strings"
)

// runnersSlice is the slice every session's unit is a direct child of
// (computer/src/host/runner-limits.ts starts them with --slice=).
const runnersSlice = "slack-presence-runners.slice"

// userManager is a user's systemd instance, the one non-slice element above
// the runners' slice when sessions are units of a user.
var userManager = regexp.MustCompile(`^user@[0-9]+\.service$`)

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
		u := runnerOf(parts[2])
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

// runnerOf is the caller a cgroup path names: the unit right below the
// runners' slice, when only slices and user managers lead to that slice.
func runnerOf(path string) string {
	elems := strings.Split(strings.TrimPrefix(path, "/"), "/")
	for i, elem := range elems {
		if elem == runnersSlice {
			if i+1 < len(elems) {
				return callerOfUnit(elems[i+1])
			}
			return ""
		}
		if !strings.HasSuffix(elem, ".slice") && !userManager.MatchString(elem) {
			return ""
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

// anyUID is -caller-uid's default: the peer's uid is not looked at.
const anyUID = -1

// peerResolver is the cgroup Resolver: SO_PEERCRED pid → cgroup → caller.
// uid: the only uid a caller may have, or anyUID.
func peerResolver(procRoot string, uid int) Resolver {
	return func(c net.Conn) string {
		pid, peerUID, ok := peerCred(c)
		if !ok || (uid != anyUID && peerUID != uid) {
			return ""
		}
		return callerOfPid(procRoot, pid)
	}
}
