package svix

import "testing"

func TestBaseURLForToken(t *testing.T) {
	cases := map[string]string{
		"sk_abc.us":   "https://api.us.svix.com",
		"sk_abc.eu":   "https://api.eu.svix.com",
		"sk_abc.in":   "https://api.in.svix.com",
		"sk_no_region": "https://api.svix.com", // no '.' suffix
		"sk_has.dot.body.us": "https://api.us.svix.com", // region is after the LAST dot
	}
	for token, want := range cases {
		if got := baseURLForToken(token); got != want {
			t.Errorf("baseURLForToken(%q) = %q, want %q", token, got, want)
		}
	}
}

func TestSanitizeEventID(t *testing.T) {
	cases := map[string]string{
		"sb-x:sandbox.stopped":          "sb-x.sandbox.stopped",
		"sb-y:sandbox.hibernated:2":     "sb-y.sandbox.hibernated.2",
		"already-clean.id_1":            "already-clean.id_1",
		"sb-z:sandbox.migrated:worker7": "sb-z.sandbox.migrated.worker7",
	}
	for in, want := range cases {
		if got := SanitizeEventID(in); got != want {
			t.Errorf("SanitizeEventID(%q) = %q, want %q", in, got, want)
		}
	}
}
