// What a WebSocket tunnel (websocket.go) reads from the messages passing
// through it, as wsframe.go hands them over piece by piece: from the client,
// a response.create and whether it is a warm-up (`"generate":false`); from
// the upstream, each event's `type`, the service tier it names and, for an
// `error` event, its status and headers.
//
// Invariants: of a message only its first bytes (wsTypeHead from the client,
// wsErrorHead from the upstream) and a tail for matches across pieces are
// kept, and only until the next one starts; an event's type is the first
// `type` in its head, which is the event's own as the upstream writes it
// first.
package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
)

// wsClientMsg reads the client's messages: a response.create starts a response.
type wsClientMsg struct {
	t       *wsTunnel
	head    []byte
	scan    tailScan
	prewarm bool
}

func (m *wsClientMsg) begin() { m.head, m.prewarm = m.head[:0], false; m.scan.reset() }

func (m *wsClientMsg) data(p []byte) {
	m.head = appendHead(m.head, p, wsTypeHead)
	if !m.prewarm && (bytes.Contains(m.scan.seam(p), markNoGenerate) || bytes.Contains(p, markNoGenerate)) {
		m.prewarm = true
	}
	m.scan.keep(p)
}

func (m *wsClientMsg) end() {
	if eventType(m.head) == "response.create" {
		m.t.created(m.prewarm)
	}
}

// wsServerMsg reads the upstream's events.
type wsServerMsg struct {
	t    *wsTunnel
	head []byte
	scan tailScan
	tier string
}

func (m *wsServerMsg) begin() { m.head, m.tier = m.head[:0], ""; m.scan.reset() }

func (m *wsServerMsg) data(p []byte) {
	m.head = appendHead(m.head, p, wsErrorHead)
	if t, ok := tierIn(m.scan.seam(p)); ok {
		m.tier = t
	}
	if t, ok := tierIn(p); ok {
		m.tier = t
	}
	m.scan.keep(p)
}

func (m *wsServerMsg) end() { m.t.event(eventType(m.head), m.tier, m.head) }

func appendHead(head, p []byte, limit int) []byte {
	return append(head, p[:min(len(p), max(0, limit-len(head)))]...)
}

// eventType is the first `type` a message's head names: the event's own.
func eventType(head []byte) string {
	i := bytes.Index(head[:min(len(head), wsTypeHead)], []byte(`"type":"`))
	if i < 0 {
		return ""
	}
	v := head[i+len(`"type":"`):]
	if j := bytes.IndexByte(v, '"'); j > 0 && j <= 64 {
		return string(v[:j])
	}
	return ""
}

// wsError reads an `error` event's status and headers, the WebSocket form
// of an HTTP error: {"type":"error","status":429,"error":{…},"headers":{…}}.
func wsError(b []byte) (int, http.Header) {
	var e struct {
		Status     int            `json:"status"`
		StatusCode int            `json:"status_code"`
		Headers    map[string]any `json:"headers"`
	}
	if json.Unmarshal(b, &e) != nil {
		return 0, nil
	}
	h := http.Header{}
	for k, v := range e.Headers {
		switch v := v.(type) {
		case string:
			h.Set(k, v)
		case float64:
			h.Set(k, strconv.FormatFloat(v, 'f', -1, 64))
		}
	}
	return max(e.Status, e.StatusCode), h
}
