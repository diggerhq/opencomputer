package proxy

// preview_managed.go — reaching a customer's own server on a managed runtime.
//
// The fleet path below dials the sandbox's container directly over TCP, because
// on QEMU the host publishes a port for it. A MicroVM has no such port: Lambda's
// proxy forwards guest traffic ONLY to the port declared on the image, so a
// second listener inside the guest is simply unreachable from outside (verified
// — the agent listens on 8081 and requests to it return 502 while the identical
// request to 8080 arrives).
//
// So the fan-out happens inside the guest. Everything enters on the hook port
// and cmd/microvm-hooks proxies /oc/port/<port>/... to 127.0.0.1:<port>. From
// out here that means three differences from the fleet path, and they are why
// this is a separate branch rather than a flag on doProxy:
//
//	TLS, not raw TCP        the box is reached over HTTPS
//	two headers             the proxy authenticates on them and routes on them
//	a path prefix           the port is in the path, not the address
//
// Retrofitting doProxy to do all three conditionally would put branches on the
// path every existing customer's preview URL takes, to serve a runtime none of
// them are on.

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"

	"github.com/labstack/echo/v4"
)

// ManagedPreview is how to reach a guest port on a runtime the control plane
// holds in-process.
type ManagedPreview struct {
	// Host is the box's HTTPS host, without a scheme.
	Host string
	// Token authenticates to the runtime's proxy.
	Token string
	// HookPort is the port the runtime's proxy will forward to — the guest's
	// front door, NOT the customer's port. The customer's port travels in the
	// path.
	HookPort int32
}

// SetManagedPreview installs a resolver for sandboxes served by a managed
// backend. Returning false sends the request down the fleet path unchanged,
// which is what every QEMU sandbox does.
func (p *ControlPlaneProxy) SetManagedPreview(fn func(sandboxID string) (ManagedPreview, bool)) {
	p.managedPreview = fn
}

// serveManagedPreview forwards a preview request to a guest port through the
// runtime's proxy.
//
// WebSocket and SSE both survive: ReverseProxy forwards an Upgrade and answers
// a 101 by splicing the connection, and FlushInterval -1 stops an event stream
// being buffered into silence. The runtime's own proxy passes both through —
// that was measured before any of this was built, with an echo endpoint over a
// WebSocket through the same hop.
func (p *ControlPlaneProxy) serveManagedPreview(c echo.Context, sandboxID string, port int, t ManagedPreview) error {
	req := c.Request()
	// The customer's path, which becomes the tail of the guest's port route.
	tail := strings.TrimPrefix(req.URL.Path, "/")

	target := &url.URL{Scheme: "https", Host: t.Host}
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL.Scheme = target.Scheme
			pr.Out.URL.Host = target.Host
			pr.Out.URL.Path = "/oc/port/" + strconv.Itoa(port) + "/" + tail
			pr.Out.URL.RawQuery = req.URL.RawQuery
			// Host must be the BOX, not the preview hostname: the runtime's
			// proxy routes on it, and sending the customer's vanity host would
			// not resolve to anything.
			pr.Out.Host = target.Host
			pr.Out.Header.Set("X-aws-proxy-auth", t.Token)
			pr.Out.Header.Set("X-aws-proxy-port", strconv.FormatInt(int64(t.HookPort), 10))
			// Forwarded headers so the customer's server sees the real client
			// rather than the control plane.
			pr.SetXForwarded()
			pr.Out.Header.Set("X-Forwarded-Host", req.Host)
			pr.Out.Header.Set("X-Forwarded-Proto", "https")
		},
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			// Almost always the customer's server not being up yet, which is a
			// normal state and must read as such rather than as a broken
			// sandbox — serveUpstreamUnavailable is the same page the fleet
			// path shows for it.
			log.Printf("proxy: managed preview %s port %d: %v", sandboxID, port, err)
			_ = serveUpstreamUnavailable(c, sandboxID, port)
		},
	}
	rp.ServeHTTP(c.Response(), req)
	return nil
}
