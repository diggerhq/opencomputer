package webhook

import (
	"context"
	"net"
	"testing"
)

func TestIsBlockedIP(t *testing.T) {
	blocked := []string{
		"127.0.0.1",        // loopback
		"::1",              // v6 loopback
		"0.0.0.0",          // unspecified
		"10.0.0.1",         // RFC1918
		"172.16.5.4",       // RFC1918
		"172.31.255.255",   // RFC1918 edge
		"192.168.1.1",      // RFC1918
		"169.254.169.254",  // link-local / cloud metadata
		"100.64.0.1",       // CGNAT
		"192.0.2.5",        // TEST-NET-1
		"198.51.100.7",     // TEST-NET-2
		"203.0.113.9",      // TEST-NET-3
		"198.18.0.1",       // benchmarking
		"224.0.0.1",        // multicast
		"240.0.0.1",        // reserved
		"255.255.255.255",  // broadcast
		"fe80::1",          // v6 link-local
		"fc00::1",          // v6 ULA
		"::ffff:127.0.0.1", // v4-mapped loopback
		"::ffff:10.0.0.1",  // v4-mapped private
	}
	for _, s := range blocked {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("test bug: unparseable %q", s)
		}
		if !isBlockedIP(ip) {
			t.Errorf("expected BLOCKED: %s", s)
		}
	}

	allowed := []string{
		"8.8.8.8",
		"1.1.1.1",
		"93.184.216.34", // example.com
		"2606:2800:220:1:248:1893:25c8:1946",
	}
	for _, s := range allowed {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("test bug: unparseable %q", s)
		}
		if isBlockedIP(ip) {
			t.Errorf("expected ALLOWED: %s", s)
		}
	}

	// nil fails closed.
	if !isBlockedIP(nil) {
		t.Error("nil IP must fail closed (blocked)")
	}
}

func TestValidateURL(t *testing.T) {
	ctx := context.Background()
	// These never hit DNS (scheme/host/literal-IP checks short-circuit).
	cases := []struct {
		url     string
		wantErr bool
		reason  string // expected SSRFError.Reason when wantErr
	}{
		{"http://example.com/hook", true, "scheme_not_https"},
		{"ftp://example.com", true, "scheme_not_https"},
		{"https://", true, "empty_host"},
		{"https://127.0.0.1/x", true, "literal_ip_blocked"},
		{"https://10.0.0.1", true, "literal_ip_blocked"},
		{"https://[::1]/x", true, "literal_ip_blocked"},
		{"https://169.254.169.254/latest/meta-data", true, "literal_ip_blocked"},
		{"https://8.8.8.8/ok", false, ""},
	}
	for _, c := range cases {
		err := ValidateURL(ctx, c.url)
		if c.wantErr {
			if err == nil {
				t.Errorf("%s: expected error", c.url)
				continue
			}
			var se *SSRFError
			if !IsSSRFError(err) {
				t.Errorf("%s: expected *SSRFError, got %T", c.url, err)
				continue
			}
			se, _ = err.(*SSRFError)
			if se.Reason != c.reason {
				t.Errorf("%s: reason = %q, want %q", c.url, se.Reason, c.reason)
			}
		} else if err != nil {
			t.Errorf("%s: unexpected error %v", c.url, err)
		}
	}
}
