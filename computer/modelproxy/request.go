// A binder's `request`: one request on a profile, made by the proxy with
// variables the binder supplies for it. It is how a binder checks a credential
// before binding anything to it, or reads an upstream's own account
// endpoints, without the credential ever being in a session.
//
// The path must be a route of the profile (not a WS one). The route's `to`,
// the profile's and the route's `set` and the route's `default` apply as for
// a session's request; `require` does not: it is a check on sessions, and
// the binder is trusted. The variables are used once and not stored.
//
// The answer is the status, the response headers the profile's `report`
// names and the start of the body; or an error: unknown_profile,
// unknown_route, missing_var (absent, or not a header value), bad_request,
// busy (maxRequests are in flight, control.go), timeout, or unreachable. It
// goes to the connection that asked.
package main

import (
	"context"
	"io"
	"net/http"
	"strings"
)

// maxResponseBody caps how much of the body a `response` carries.
const maxResponseBody = 16 << 10

func (ps *profiles) request(ctx context.Context, m requestMsg) responseMsg {
	prof := ps.get(m.Profile)
	if prof == nil {
		return responseMsg{Error: responseUnknownProfile}
	}
	rs := prof.routes[m.Method+" "+m.Path]
	if rs == nil || rs.ws {
		return responseMsg{Error: responseUnknownRoute}
	}
	for _, v := range prof.vars {
		if val := m.Vars[v]; val == "" || !validHeaderValue(val) {
			return responseMsg{Error: responseMissingVar}
		}
	}
	var body io.Reader
	if m.Body != "" {
		body = strings.NewReader(m.Body)
	}
	req, err := http.NewRequestWithContext(ctx, m.Method, "https://"+prof.url.Host+m.Path, body)
	if err != nil {
		return responseMsg{Error: responseBadRequest}
	}
	req.URL.RawQuery = m.Query
	for k, v := range m.Headers {
		if !validHeaderName(k) || !validHeaderValue(v) {
			return responseMsg{Error: responseBadRequest}
		}
		req.Header.Set(k, v)
	}
	prof.target(req, rs)
	prof.headers(req.Header, rs, m.Vars)
	res, err := prof.up.transport.RoundTrip(req)
	if err != nil {
		if errorClass(err) == "timeout" {
			return responseMsg{Error: responseTimeout}
		}
		return responseMsg{Error: responseUnreachable}
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(res.Body, maxResponseBody))
	return responseMsg{Status: res.StatusCode, Headers: reported(prof.report, res.Header), Body: string(b)}
}
