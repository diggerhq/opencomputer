package commands

import "testing"

func TestSessionCreateDoesNotExposeRevisionFlag(t *testing.T) {
	if flag := sessionCreateCmd.Flags().Lookup("revision"); flag != nil {
		t.Fatal("session create must not expose unsupported revision selection")
	}
}

func TestParseSources(t *testing.T) {
	ok := []struct {
		in       []string
		wantRepo []string
		wantRef  []string
	}{
		{[]string{"acme/agents"}, []string{"acme/agents"}, []string{"HEAD"}},
		{[]string{"acme/agents@main"}, []string{"acme/agents"}, []string{"main"}},
		{[]string{"acme/agents@refs/pull/5/head"}, []string{"acme/agents"}, []string{"refs/pull/5/head"}},
		{[]string{"  acme/agents  "}, []string{"acme/agents"}, []string{"HEAD"}},
		{[]string{"acme/agents@"}, []string{"acme/agents"}, []string{"HEAD"}}, // empty ref → HEAD
		{[]string{"a/b", "c/d@dev"}, []string{"a/b", "c/d"}, []string{"HEAD", "dev"}},
		{[]string{"", "  "}, nil, nil}, // blanks skipped
		{nil, nil, nil},
	}
	for _, c := range ok {
		got, err := parseSources(c.in)
		if err != nil {
			t.Fatalf("parseSources(%v) unexpected error: %v", c.in, err)
		}
		if len(got) != len(c.wantRepo) {
			t.Fatalf("parseSources(%v) = %d sources, want %d", c.in, len(got), len(c.wantRepo))
		}
		for i := range got {
			if got[i]["repo"] != c.wantRepo[i] {
				t.Errorf("parseSources(%v)[%d].repo = %v, want %s", c.in, i, got[i]["repo"], c.wantRepo[i])
			}
			if got[i]["ref"] != c.wantRef[i] {
				t.Errorf("parseSources(%v)[%d].ref = %v, want %s", c.in, i, got[i]["ref"], c.wantRef[i])
			}
		}
	}

	bad := [][]string{
		{"notarepo"},         // no slash
		{"owner/repo/extra"}, // two slashes
		{"/repo"},            // leading slash
		{"owner/"},           // trailing slash
	}
	for _, in := range bad {
		if _, err := parseSources(in); err == nil {
			t.Errorf("parseSources(%v) expected an error, got nil", in)
		}
	}
}
