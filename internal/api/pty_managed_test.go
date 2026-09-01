package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// pty_managed_test.go — the splice, which is where a terminal breaks quietly.
//
// A PTY that drops a frame does not error; it renders wrong. A pump that
// outlives its session does not error either; it leaks a goroutine and a PTY on
// the box, once per detach, until the box dies.

var testUpgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

// wsPair returns a connected client/server pair over a real socket.
func wsPair(t *testing.T) (client, server *websocket.Conn, closeAll func()) {
	t.Helper()
	srvCh := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		srvCh <- c
		<-r.Context().Done()
	}))
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	s := <-srvCh
	return c, s, func() { c.Close(); s.Close(); srv.Close() }
}

// Frames cross the splice byte-for-byte. The two sides speak the same protocol,
// so anything this handler "helpfully" rewrote would be a second, divergent
// implementation of it.
func TestPumpCopiesFramesVerbatim(t *testing.T) {
	aClient, aServer, closeA := wsPair(t)
	defer closeA()
	bClient, bServer, closeB := wsPair(t)
	defer closeB()

	done := make(chan struct{}, 2)
	go pumpWS(bClient, aServer, done)

	payload := `{"data":"aGVsbG8=","cols":120,"rows":40}`
	if err := aClient.WriteMessage(websocket.TextMessage, []byte(payload)); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = bServer.SetReadDeadline(time.Now().Add(3 * time.Second))
	mt, got, err := bServer.ReadMessage()
	if err != nil {
		t.Fatalf("read through the splice: %v", err)
	}
	if mt != websocket.TextMessage {
		t.Errorf("message type = %d, want text — a rewritten type breaks binary PTY output", mt)
	}
	if string(got) != payload {
		t.Errorf("frame = %q, want it unchanged: %q", got, payload)
	}
}

// A pump must end when its source closes, or every detached terminal leaves a
// goroutine and a live PTY behind on the box.
func TestPumpEndsWhenSourceCloses(t *testing.T) {
	aClient, aServer, closeA := wsPair(t)
	defer closeA()
	bClient, _, closeB := wsPair(t)
	defer closeB()

	done := make(chan struct{}, 1)
	go pumpWS(bClient, aServer, done)

	aClient.Close()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("pump outlived its source socket — one leaked goroutine and PTY per detach")
	}
}

// And when its destination closes: the customer hanging up must tear down the
// box side too, not just stop reading from it.
func TestPumpEndsWhenDestinationCloses(t *testing.T) {
	aClient, aServer, closeA := wsPair(t)
	defer closeA()
	bClient, _, closeB := wsPair(t)
	defer closeB()

	done := make(chan struct{}, 1)
	go pumpWS(bClient, aServer, done)

	bClient.Close()
	// A write has to be attempted before a closed destination is noticed, which
	// is what this frame is for.
	_ = aClient.WriteMessage(websocket.TextMessage, []byte(`{"data":"eA=="}`))

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("pump outlived its destination socket")
	}
}
