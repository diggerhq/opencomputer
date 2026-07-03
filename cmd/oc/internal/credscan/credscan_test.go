package credscan

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFlagsRealKeys(t *testing.T) {
	cases := []struct {
		name, kind, content string
	}{
		{"anthropic api", "Anthropic API key", `const c = "sk-ant-api03-AbCdEf0123456789AbCdEf0123456789_-xyzTUV";`},
		{"anthropic oat", "Anthropic API key", `ANTHROPIC_API_KEY=sk-ant-oat01-ZZZ0123456789ABCDEFGHIJ0123456789klmnop`},
		{"openai proj", "OpenAI project key", `key: 'sk-proj-abcdef0123456789ABCDEFGHIJ0123456789xyz'`},
		{"openrouter", "OpenRouter API key", `OPENROUTER_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef"`},
		{"google", "Google API key", `AIzaSyA1234567890abcdefghijklmnopqrstuvw`},
	}
	for _, c := range cases {
		f := ScanBytes("x.ts", []byte(c.content))
		if len(f) == 0 {
			t.Errorf("%s: expected a finding, got none", c.name)
			continue
		}
		if f[0].Kind != c.kind {
			t.Errorf("%s: kind = %q, want %q", c.name, f[0].Kind, c.kind)
		}
		if strings.Contains(c.content, f[0].Match) {
			t.Errorf("%s: match %q is not redacted (appears verbatim)", c.name, f[0].Match)
		}
	}
}

func TestPEMPrivateKeyFlagged(t *testing.T) {
	pem := "-----BEGIN RSA PRIVATE KEY-----\n" +
		"MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF0qXo3pEGuTs2Z9tWnZ2Vtis3Vs\n" +
		"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6A7B8C9D0E1F2\n" +
		"-----END RSA PRIVATE KEY-----"
	if f := ScanBytes("key.pem", []byte(pem)); len(f) == 0 {
		t.Fatal("expected PEM private key to be flagged")
	}
}

// The false-positive leg (matrix row 13b): the bare literal "sk-ant-oat" that
// pi-ai's dist ships (apiKey.includes('sk-ant-oat')) must NOT trip the scan, nor
// must ordinary starter code.
func TestNoFalsePositives(t *testing.T) {
	clean := []string{
		`if (apiKey.includes('sk-ant-oat') || apiKey.includes('sk-ant-api')) { /* ... */ }`,
		`// keys look like sk-ant-... — never commit them`,
		`import * as v from 'valibot';`,
		`const orders = await import('../data/orders.json', { with: { type: 'json' } });`,
		`export const model = 'anthropic/claude-sonnet-5';`,
		`-----BEGIN PRIVATE KEY-----`,                             // header alone, no base64 body
		`const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";`, // 40-hex git sha, not sk- shaped
		`const id = "sk";`,
	}
	for _, c := range clean {
		if f := ScanBytes("x.ts", []byte(c)); len(f) != 0 {
			t.Errorf("false positive on %q: %+v", c, f)
		}
	}
}

func TestScanDirSkipsBuildAndDeps(t *testing.T) {
	root := t.TempDir()
	realKey := "sk-ant-api03-AbCdEf0123456789AbCdEf0123456789_-xyzTUV"
	mustWrite(t, filepath.Join(root, "src", "opencomputer.ts"), "export const ok = 1;\n")
	// A key inside skipped trees must be ignored (bundled deps / build output).
	mustWrite(t, filepath.Join(root, "node_modules", "pi-ai", "dist.js"), "x="+realKey+"\n")
	mustWrite(t, filepath.Join(root, "dist-oc", "oc.js"), "y="+realKey+"\n")

	f, err := ScanDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(f) != 0 {
		t.Fatalf("expected no findings (keys were only in skipped dirs), got %+v", f)
	}

	// The same key in a real source file IS flagged, with a repo-relative path.
	mustWrite(t, filepath.Join(root, "src", "tools", "leak.ts"), "const k = '"+realKey+"';\n")
	f, err = ScanDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(f) != 1 {
		t.Fatalf("expected 1 finding, got %d: %+v", len(f), f)
	}
	if f[0].Path != "src/tools/leak.ts" {
		t.Errorf("path = %q, want src/tools/leak.ts", f[0].Path)
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
