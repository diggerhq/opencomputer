package webhook

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"
)

// SSRFError is returned when a webhook URL is refused for pointing at a
// disallowed address (at registration or at send time). The dispatcher
// classifies it as a permanent failure (dead-letter, never retried).
type SSRFError struct {
	Reason string // machine-readable: scheme_not_https, blocked_ip, unresolvable, ...
	Detail string
}

func (e *SSRFError) Error() string { return fmt.Sprintf("ssrf: %s (%s)", e.Reason, e.Detail) }

// IsSSRFError reports whether err is (or wraps) an *SSRFError.
func IsSSRFError(err error) bool {
	var e *SSRFError
	return errors.As(err, &e)
}

// blockedNets are CIDR ranges we refuse to deliver to, on top of the net.IP
// classification helpers used in isBlockedIP. Ported from sessions-api
// src/v3/delivery/ssrf.ts; we fail CLOSED — if any resolved address of a host
// falls in a blocked range, the whole host is refused.
var blockedNets = mustParseCIDRs(
	"0.0.0.0/8",          // "this network"
	"169.254.0.0/16",     // link-local + cloud metadata (169.254.169.254)
	"192.0.0.0/24",       // IETF protocol assignments
	"192.0.2.0/24",       // TEST-NET-1
	"198.18.0.0/15",      // benchmarking
	"198.51.100.0/24",    // TEST-NET-2
	"203.0.113.0/24",     // TEST-NET-3
	"100.64.0.0/10",      // CGNAT (RFC 6598)
	"240.0.0.0/4",        // reserved
	"255.255.255.255/32", // limited broadcast
	"fec0::/10",          // IPv6 site-local (deprecated)
)

func mustParseCIDRs(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			panic("webhook: bad blocked CIDR " + c + ": " + err.Error())
		}
		out = append(out, n)
	}
	return out
}

// isBlockedIP reports whether ip is in a disallowed range. nil (unparseable)
// fails closed. IPv4-mapped IPv6 is normalized so a mapped loopback/private
// address can't slip through.
func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	if ip.IsLoopback() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() || ip.IsInterfaceLocalMulticast() ||
		ip.IsPrivate() { // 10/8, 172.16/12, 192.168/16, fc00::/7
		return true
	}
	for _, n := range blockedNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// ValidateURL enforces the registration-time policy: https only, a non-empty
// host, and every resolved address allowed (fail closed). Use it on
// POST/PATCH /api/webhooks before persisting a destination.
func ValidateURL(ctx context.Context, raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return &SSRFError{Reason: "invalid_url", Detail: err.Error()}
	}
	if u.Scheme != "https" {
		return &SSRFError{Reason: "scheme_not_https", Detail: u.Scheme}
	}
	host := u.Hostname()
	if host == "" {
		return &SSRFError{Reason: "empty_host", Detail: raw}
	}
	if lit := net.ParseIP(host); lit != nil {
		if isBlockedIP(lit) {
			return &SSRFError{Reason: "literal_ip_blocked", Detail: host}
		}
		return nil
	}
	resolved, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(resolved) == 0 {
		return &SSRFError{Reason: "unresolvable", Detail: host}
	}
	for _, a := range resolved {
		if isBlockedIP(a.IP) {
			return &SSRFError{Reason: "blocked_ip", Detail: a.IP.String()}
		}
	}
	return nil
}

// SafeClient returns an *http.Client that, on every connection, re-resolves the
// host, refuses it if any address is blocked, and PINS the TCP connection to the
// vetted IP — defeating DNS-rebind between validation and send. It does not
// follow redirects (a 3xx is returned as-is so the dispatcher can dead-letter
// it). The URL hostname is still used for TLS SNI / certificate verification,
// because only the dial address is overridden.
func SafeClient(connectTimeout, totalTimeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: connectTimeout}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return safeDial(ctx, dialer, network, addr)
		},
		TLSHandshakeTimeout:   connectTimeout,
		ResponseHeaderTimeout: totalTimeout,
		DisableKeepAlives:     true,
	}
	return &http.Client{
		Transport:     tr,
		Timeout:       totalTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// safeDial resolves addr, refuses it if any resolved IP is blocked (fail
// closed), and dials the first vetted IP.
func safeDial(ctx context.Context, dialer *net.Dialer, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	var ips []net.IP
	if lit := net.ParseIP(host); lit != nil {
		ips = []net.IP{lit}
	} else {
		resolved, rerr := net.DefaultResolver.LookupIPAddr(ctx, host)
		if rerr != nil {
			return nil, &SSRFError{Reason: "unresolvable", Detail: host}
		}
		for _, a := range resolved {
			ips = append(ips, a.IP)
		}
	}
	if len(ips) == 0 {
		return nil, &SSRFError{Reason: "unresolvable", Detail: host}
	}
	for _, ip := range ips {
		if isBlockedIP(ip) {
			return nil, &SSRFError{Reason: "blocked_ip", Detail: ip.String()}
		}
	}
	return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
}
