// The control socket: the binder's one connection to the proxy. JSON lines
// both ways (frames.go). The proxy speaks first (`hello` with its profiles
// and the bindings it holds), the binder re-sends every live bind and then
// `synced`.
//
// Invariants:
//   - At most one control connection is live; a new one replaces the old.
//   - Sending never blocks: messages go through a bounded queue and are
//     dropped (counted, reported in model.pool) when it is full or no binder
//     is connected.
//     Lifecycle events from before the first connection are kept (a few) and
//     sent after `hello`.
//   - A failed accept is retried with a backoff; only closing the listener
//     ends Serve.
//   - A line that carries variables (`bind`, `request`) is never logged.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const (
	controlQueue   = 8192
	maxPending     = 32
	maxControlLine = 1 << 20
	writeTimeout   = 5 * time.Second
	requestTimeout = 15 * time.Second // a binder's `request` (request.go)
	maxRequests    = 16               // such requests in flight; past it: error "busy"
	acceptBackoff  = time.Second      // the longest wait between failed accepts
)

type Control struct {
	version     string
	placeholder string
	bindings    *Bindings
	profiles    *profiles

	mu      sync.Mutex
	cur     *ctrlConn
	pending [][]byte
	closed  bool
	dropped atomic.Int64
	wg      sync.WaitGroup
	reqs    chan struct{} // maxRequests slots
	now     func() time.Time
}

type ctrlConn struct {
	c       net.Conn
	out     chan []byte
	done    chan struct{}
	once    sync.Once
	helloAt time.Time
}

func (cc *ctrlConn) close() {
	cc.once.Do(func() {
		close(cc.done)
		cc.c.Close()
	})
}

func NewControl(version, placeholder string, ps *profiles) *Control {
	return &Control{version: version, placeholder: placeholder, profiles: ps, now: time.Now, reqs: make(chan struct{}, maxRequests)}
}

// hello is the first line of a connection (frames.go).
func (c *Control) hello(bindings []bindingInfo) helloMsg {
	h := helloMsg{T: "hello", Version: c.version, Protocol: controlProtocol, Placeholder: c.placeholder,
		Profiles: make([]helloProfile, 0, len(c.profiles.sorted)), Bindings: bindings}
	for _, p := range c.profiles.sorted {
		h.Profiles = append(h.Profiles, helloProfile{Name: p.name, Vars: p.vars, Harness: p.harness})
	}
	return h
}

// send queues v for the binder; dropped when there is none or the queue is full.
func (c *Control) send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	b = append(b, '\n')
	c.mu.Lock()
	cur := c.cur
	c.mu.Unlock()
	if cur == nil {
		c.dropped.Add(1)
		return
	}
	select {
	case cur.out <- b:
	default:
		c.dropped.Add(1)
	}
}

// reply answers a `request` on the connection that asked: a binder that has
// reconnected since never gets an answer to an id it did not send.
func (c *Control) reply(cc *ctrlConn, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case cc.out <- append(b, '\n'):
	default:
		c.dropped.Add(1)
	}
}

// sendKept is send, but kept for the first binder when none is connected yet.
func (c *Control) sendKept(v any) {
	c.mu.Lock()
	if c.cur == nil && !c.closed {
		if len(c.pending) < maxPending {
			b, err := json.Marshal(v)
			if err == nil {
				c.pending = append(c.pending, append(b, '\n'))
			}
		}
		c.mu.Unlock()
		return
	}
	c.mu.Unlock()
	c.send(v)
}

// Dropped is how many messages never reached a binder.
func (c *Control) Dropped() int64 { return c.dropped.Load() }

// Serve accepts control connections until l is closed.
func (c *Control) Serve(l net.Listener) {
	var wait time.Duration
	for {
		conn, err := l.Accept()
		if errors.Is(err, net.ErrClosed) {
			return
		}
		if err != nil {
			wait = min(max(2*wait, 5*time.Millisecond), acceptBackoff)
			logWarn("control accept failed; retrying", "error", err.Error(), "wait_ms", ms(wait))
			time.Sleep(wait)
			continue
		}
		wait = 0
		c.wg.Add(1)
		go func() {
			defer c.wg.Done()
			c.handle(conn)
		}()
	}
}

func (c *Control) handle(conn net.Conn) {
	cc := &ctrlConn{c: conn, out: make(chan []byte, controlQueue), done: make(chan struct{}), helloAt: c.now()}
	snap := c.bindings.Snapshot()
	hb, _ := json.Marshal(c.hello(snap))
	cc.out <- append(hb, '\n')

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		conn.Close()
		return
	}
	for _, p := range c.pending {
		cc.out <- p
	}
	c.pending = nil
	old := c.cur
	c.cur = cc
	c.mu.Unlock()
	if old != nil {
		logInfo("control connection replaced")
		old.close()
	}
	logInfo("control connected", "bindings", len(snap))

	go c.writer(cc)
	c.reader(cc)

	cc.close()
	c.mu.Lock()
	if c.cur == cc {
		c.cur = nil
	}
	c.mu.Unlock()
	logInfo("control disconnected")
}

func (c *Control) writer(cc *ctrlConn) {
	w := bufio.NewWriterSize(cc.c, 64<<10)
	for {
		select {
		case b := <-cc.out:
			cc.c.SetWriteDeadline(c.now().Add(writeTimeout))
			if _, err := w.Write(b); err != nil {
				cc.close()
				return
			}
			if len(cc.out) == 0 {
				if err := w.Flush(); err != nil {
					cc.close()
					return
				}
			}
		case <-cc.done:
			return
		}
	}
}

func (c *Control) reader(cc *ctrlConn) {
	sc := bufio.NewScanner(cc.c)
	sc.Buffer(make([]byte, 64<<10), maxControlLine)
	for sc.Scan() {
		line := sc.Bytes()
		var head inHead
		if err := json.Unmarshal(line, &head); err != nil {
			logWarn("control: unparsable line")
			continue
		}
		switch head.T {
		case "bind":
			var m bindMsg
			if json.Unmarshal(line, &m) != nil {
				c.reply(cc, refusedMsg{T: "refused", Code: refuseBadFrame, Message: "bind is not a JSON object of the documented shape"})
				continue
			}
			c.bindings.Bind(m)
		case "release":
			var m releaseMsg
			if json.Unmarshal(line, &m) == nil {
				c.bindings.Release(m.Caller)
			}
		case "synced":
			waiting := c.bindings.Synced()
			logInfo("synced", "bindings", c.bindings.Len(), "waiting", waiting, "since_hello_ms", ms(c.now().Sub(cc.helloAt)))
		case "request":
			var m requestMsg
			if json.Unmarshal(line, &m) != nil {
				continue
			}
			select {
			case c.reqs <- struct{}{}:
			default:
				c.reply(cc, responseMsg{T: "response", ID: m.ID, Error: responseBusy})
				continue
			}
			c.wg.Add(1)
			go func() {
				defer c.wg.Done()
				defer func() { <-c.reqs }()
				ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
				defer cancel()
				r := c.profiles.request(ctx, m)
				r.T, r.ID = "response", m.ID
				c.reply(cc, r)
			}()
		}
	}
}

// Close drops the binder's connection (so it reconnects to the next instance at
// once) and refuses new ones.
func (c *Control) Close() {
	c.mu.Lock()
	c.closed = true
	cur := c.cur
	c.cur = nil
	c.mu.Unlock()
	if cur != nil {
		cur.close()
	}
}
