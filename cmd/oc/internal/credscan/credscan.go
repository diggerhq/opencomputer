// Package credscan is the CLI's PRIMARY credential scan (flue-slice.md
// contract, design 012 §11.2.6): before a Flue app is bundled and uploaded, walk
// the user's own source files and refuse to deploy if any looks like a committed
// provider key. Model credentials come only from the OC credential attached to
// the agent — never from code.
//
// Patterns match the FULL key shape including the body, never a bare prefix. A
// bare `sk-ant-` grep is a guaranteed false positive: pi-ai's dist ships the
// literal string "sk-ant-oat" (anthropic-messages.js, apiKey.includes(...)), so
// a prefix scan fails the unmodified starter. The CLI scans pre-bundle sources
// (best signal — user code, pre-minification); the deploy's artifact-fileset
// scan is the entropy-gated backstop for anything that slips through.
package credscan

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Finding is one suspected credential.
type Finding struct {
	Path  string // file, relative to the scanned root
	Line  int    // 1-based
	Kind  string // human label, e.g. "Anthropic API key"
	Match string // the redacted matched token
}

// patterns are full-key-shape matchers. Each captures enough of the body to be
// high-confidence; prefixes alone are never used.
var patterns = []struct {
	kind string
	re   *regexp.Regexp
}{
	// Anthropic: sk-ant-api03-… / sk-ant-oat01-… — prefix + 2 version digits + a
	// long body. The body length is what separates a real key from the literal
	// "sk-ant-oat" that appears (bodiless) in pi-ai's dist.
	{"Anthropic API key", regexp.MustCompile(`sk-ant-(?:api|oat)\d{2}-[A-Za-z0-9_-]{24,}`)},
	// OpenAI: sk-… and project keys sk-proj-… with a long body.
	{"OpenAI project key", regexp.MustCompile(`sk-proj-[A-Za-z0-9_-]{24,}`)},
	{"OpenAI API key", regexp.MustCompile(`sk-[A-Za-z0-9]{32,}`)},
	// OpenRouter.
	{"OpenRouter API key", regexp.MustCompile(`sk-or-v1-[A-Za-z0-9]{32,}`)},
	// Google AI Studio / Gemini.
	{"Google API key", regexp.MustCompile(`AIza[A-Za-z0-9_-]{35}`)},
	// PEM private key block (with a base64 body, not just the header line).
	{"Private key (PEM)", regexp.MustCompile(`-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[A-Za-z0-9+/=\s]{40,}-----END`)},
}

// scanExts are the text source extensions worth scanning. A Flue app's secrets
// would live in code/config, not in binary assets.
var scanExts = map[string]bool{
	".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
	".json": true, ".jsonc": true, ".env": true, ".yaml": true, ".yml": true,
	".toml": true, ".md": true, ".txt": true, ".sh": true, ".bash": true,
}

// skipDirs are never descended into: build output, deps, vcs.
var skipDirs = map[string]bool{
	"node_modules": true, "dist-oc": true, "dist": true, ".git": true,
	".flue": true, "build": true, "coverage": true, ".next": true, "out": true,
}

const maxFileBytes = 2 << 20 // 2 MiB — skip anything larger (not hand-authored source)

// ScanDir walks root and returns findings from every scannable source file.
// Build output, node_modules, and VCS dirs are skipped (contract: pre-bundle
// user sources only).
func ScanDir(root string) ([]Finding, error) {
	var findings []Finding
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			if p != root && skipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if !scanExts[strings.ToLower(filepath.Ext(p))] {
			return nil
		}
		info, err := d.Info()
		if err == nil && info.Size() > maxFileBytes {
			return nil
		}
		content, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(root, p)
		if relErr != nil {
			rel = p
		}
		findings = append(findings, ScanBytes(filepath.ToSlash(rel), content)...)
		return nil
	})
	return findings, err
}

// ScanBytes scans one file's content. Pure and deterministic — the unit-test
// entry point. Matching is over the whole content (not line-by-line) so
// multi-line shapes like PEM blocks are caught; the line number is derived from
// the match offset. Findings are sorted by line for a stable report.
func ScanBytes(path string, content []byte) []Finding {
	var out []Finding
	s := string(content)
	for _, p := range patterns {
		for _, loc := range p.re.FindAllStringIndex(s, -1) {
			out = append(out, Finding{
				Path:  path,
				Line:  1 + strings.Count(s[:loc[0]], "\n"),
				Kind:  p.kind,
				Match: redact(s[loc[0]:loc[1]]),
			})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Line != out[j].Line {
			return out[i].Line < out[j].Line
		}
		return out[i].Kind < out[j].Kind
	})
	return out
}

// redact keeps a short recognizable head + tail so a report is actionable
// without printing the secret in full.
func redact(s string) string {
	s = strings.ReplaceAll(s, "\n", "")
	s = strings.ReplaceAll(s, "\r", "")
	if len(s) <= 14 {
		return s[:min(len(s), 8)] + "…"
	}
	return s[:10] + "…" + s[len(s)-4:]
}
