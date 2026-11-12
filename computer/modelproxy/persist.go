// The bindings table on disk (-bindings-file, /run/oc-modelproxy/bindings.json;
// the directory is a tmpfiles.d one, not RuntimeDirectory=, which would go
// when the service stops and take the activated sockets with it: see
// deploy/vm/modelproxy.sh): unit → sessionKey, profile, key, mode. Never a
// binding's variables. Read once at start so a restarted proxy holds known
// callers instead of answering 401; written atomically (temp file, fsync,
// rename) by one goroutine that coalesces bursts of changes.
//
// Versions: 3 writes `profile` and `key`. 1 and 2, from before profiles,
// have `provider` (2 only) and `fingerprint` instead: both load, an entry
// without a provider as -default-profile (bindings.go Restore), so a proxy
// upgraded under live sessions keeps them. A newer version is read the same
// way, best effort, rather than dropping every session.
package main

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// persistVersion is what writeBindings writes.
const persistVersion = 3

type persistFile struct {
	Version  int         `json:"version"`
	Bindings []persisted `json:"bindings"`
}

func loadBindings(path string) ([]persisted, error) {
	if path == "" {
		return nil, nil
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var f persistFile
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	if f.Version > persistVersion {
		logWarn("bindings file is newer than this proxy; reading it as version 3", "version", f.Version)
	}
	return f.Bindings, nil
}

func writeBindings(path string, entries []persisted) error {
	b, err := json.Marshal(persistFile{Version: persistVersion, Bindings: entries})
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".bindings-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// persister writes the table whenever it is marked dirty, off the request path.
type persister struct {
	path     string
	snapshot func() []persisted
	kick     chan struct{}
	stop     chan struct{}
	done     chan struct{}
	once     sync.Once
}

func newPersister(path string, snapshot func() []persisted) *persister {
	return &persister{path: path, snapshot: snapshot, kick: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{})}
}

func (p *persister) markDirty() {
	select {
	case p.kick <- struct{}{}:
	default:
	}
}

func (p *persister) run() {
	defer close(p.done)
	for {
		select {
		case <-p.kick:
			p.flush()
		case <-p.stop:
			select {
			case <-p.kick:
				p.flush()
			default:
			}
			return
		}
	}
}

func (p *persister) flush() {
	if p.path == "" {
		return
	}
	if err := writeBindings(p.path, p.snapshot()); err != nil {
		logWarn("bindings write failed", "error", err.Error())
	}
}

// close writes any pending change and stops the goroutine.
func (p *persister) close() {
	p.once.Do(func() { close(p.stop) })
	<-p.done
}
