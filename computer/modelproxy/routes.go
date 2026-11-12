// What the proxy checks before a request has a profile, and the error bodies
// it writes itself: Anthropic's JSON error shape, which Claude Code reports
// like any API error and other clients read `error.message` from.
//
// Texts are neutral by default; a profile may replace those in `texts` with
// its `errors` map (profile.go).
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Texts of refusals made before, or without, a profile.
const (
	textNotFound    = "Not found: this endpoint is not served by the model proxy."
	textCredentials = "Unexpected credentials: the model proxy injects them."
	textUnknownUnit = "This process is not a session bound to a model credential."
	textUnbound     = "This session is not bound to a model credential."
	textUnitCap     = "Too many concurrent requests from this session; retry."
	textNoWebSocket = "WebSocket upgrades are not served on this endpoint."
	textWSRefused   = "The upstream refused the WebSocket (%d)."
)

// texts are the refusals a profile may word itself; the JSON keys of its
// `errors` map are the field names.
type texts struct {
	require, notReady, refused, refusedPrefix, unreachable, concurrency string
}

var defaultTexts = texts{
	require:       "This request is not allowed for this session's model credential.",
	notReady:      "The model credential for this session is not ready yet; retry.",
	refused:       "Model access is unavailable for this session.",
	refusedPrefix: "Model access unavailable: ",
	unreachable:   "The model proxy could not reach the upstream.",
	concurrency:   "Too many concurrent requests on this credential; retry.",
}

func (t *texts) override(m map[string]string) error {
	for k, v := range m {
		switch k {
		case "require":
			t.require = v
		case "notReady":
			t.notReady = v
		case "refused":
			t.refused = v
		case "refusedPrefix":
			t.refusedPrefix = v
		case "unreachable":
			t.unreachable = v
		case "concurrency":
			t.concurrency = v
		default:
			return fmt.Errorf("errors: unknown key %q", k)
		}
	}
	return nil
}

// placeholderOK: the caller sends no credential, or only the placeholder its
// client needs to be configured with (-placeholder). The proxy injects the
// real one; anything else is a caller trying its own.
func placeholderOK(h http.Header, placeholder string) bool {
	if v := h.Values("Authorization"); len(v) > 1 || (len(v) == 1 && v[0] != "Bearer "+placeholder) {
		return false
	}
	v := h.Values("X-Api-Key")
	return len(v) == 0 || (len(v) == 1 && v[0] == placeholder)
}

// isUpgrade: the request asks to switch protocols (a WebSocket): its
// Connection lists `upgrade` (RFC 9110 §7.8). Only a profile's WS route
// serves one; anywhere else it is refused with 426 rather than let
// ReverseProxy tunnel a connection the proxy cannot observe. A bare Upgrade
// header is no request to switch: it is a hop-by-hop header ReverseProxy
// strips.
func isUpgrade(h http.Header) bool {
	for _, v := range h["Connection"] {
		for t := range strings.SplitSeq(v, ",") {
			if strings.EqualFold(strings.TrimSpace(t), "upgrade") {
				return true
			}
		}
	}
	return false
}

// wsHandshakeOK: a WebSocket upgrade, version 13, with a key.
func wsHandshakeOK(h http.Header) bool {
	return strings.EqualFold(h.Get("Upgrade"), "websocket") && h.Get("Sec-Websocket-Version") == "13" && h.Get("Sec-Websocket-Key") != ""
}

type apiError struct {
	Type  string `json:"type"`
	Error struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

func writeAPIError(w http.ResponseWriter, status int, typ, msg string) {
	b := apiErrorHeaders(w.Header(), status, typ, msg)
	w.WriteHeader(status)
	w.Write(b)
}

// apiErrorHeaders sets an API error's headers on h and returns its body.
func apiErrorHeaders(h http.Header, status int, typ, msg string) []byte {
	var e apiError
	e.Type = "error"
	e.Error.Type, e.Error.Message = typ, msg
	b, _ := json.Marshal(e)
	h.Set("Content-Type", "application/json")
	switch status {
	case http.StatusServiceUnavailable, http.StatusTooManyRequests:
		h.Set("Retry-After", "1")
		h.Set("X-Should-Retry", "true")
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusUpgradeRequired:
		h.Set("X-Should-Retry", "false") // retrying cannot help; fail the turn now
	}
	return b
}
