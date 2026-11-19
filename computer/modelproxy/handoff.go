// A restart without a gap, by github.com/cloudflare/tableflip. On SIGUSR2
// the proxy starts its replacement, the same command line and so the binary
// and the profiles now on disk, and passes it the two listening sockets.
// When the replacement is ready, this process stops accepting and exits once
// its streams end (main.go); new connections are the replacement's, which
// holds each caller's requests until the binder re-binds, as after any start.
//
// Invariants:
//   - A replacement that does not become ready (profiles that do not load, a
//     crash, a minute without a word) changes nothing: this process goes on
//     serving, and says so in its log.
//   - One replacement at a time, and none while the process this one replaced
//     is still draining: such a SIGUSR2 is logged and otherwise ignored.
//   - A socket is found by name, not by path: the replaced process's, else
//     systemd's (activation.go), else a new one.
//   - The service manager is told the replacement's pid (MAINPID) before the
//     replaced process is told to go, so it never sees its main process exit.
//     A unit that uses the handoff needs NotifyAccess=all: the replacement
//     is not the main process when it says so.
//   - The socket files are never unlinked: systemd's are its own, and a new
//     one replaces a stale one (listenUnix).
package main

import (
	"fmt"
	"net"
	"os"

	"github.com/cloudflare/tableflip"
)

type handoff struct{ upg *tableflip.Upgrader }

// newHandoff is called once, before any socket is opened.
func newHandoff() (*handoff, error) {
	upg, err := tableflip.New(tableflip.Options{})
	if err != nil {
		return nil, err
	}
	return &handoff{upg: upg}, nil
}

// listener is the socket called name: the replaced process's, else the
// activated one, else a new one at path. Whichever it is goes to the next
// replacement.
func (h *handoff) listener(name, path string, activated map[string]net.Listener) (net.Listener, error) {
	l, err := h.upg.Listener("unix", name)
	if err != nil || l != nil {
		return l, err
	}
	if l = activated[name]; l == nil {
		if l, err = listenUnix(path); err != nil {
			return nil, err
		}
	}
	tl, ok := l.(tableflip.Listener)
	if !ok {
		return nil, fmt.Errorf("%s socket: a %T cannot be handed off", name, l)
	}
	if err := h.upg.AddListener("unix", name, tl); err != nil {
		return nil, err
	}
	return l, nil
}

// ready tells the service manager, then the replaced process if there is
// one, that this process serves.
func (h *handoff) ready() error {
	sdNotify(fmt.Sprintf("MAINPID=%d\nREADY=1", os.Getpid()))
	return h.upg.Ready()
}

// replace starts the replacement; it returns at once.
func (h *handoff) replace() {
	go func() {
		if err := h.upg.Upgrade(); err != nil {
			logError("handoff failed; still serving", "error", err.Error())
		}
	}()
}

// replaced is closed when the replacement is ready.
func (h *handoff) replaced() <-chan struct{} { return h.upg.Exit() }
