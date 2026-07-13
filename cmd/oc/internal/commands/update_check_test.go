package commands

import "testing"

func TestIsReleaseVersion(t *testing.T) {
	t.Parallel()
	cases := map[string]bool{
		"0.6.0.8":             true,
		"1.0":                 true,
		"dev":                 false,
		"flue-native-67bf0ee": false,
		"0.6.0.8-dirty":       false,
		"v0.6.0.8":            false,
		"0":                   false,
		"0..8":                false,
	}
	for version, want := range cases {
		version, want := version, want
		t.Run(version, func(t *testing.T) {
			t.Parallel()
			if got := isReleaseVersion(version); got != want {
				t.Fatalf("isReleaseVersion(%q) = %v, want %v", version, got, want)
			}
		})
	}
}
