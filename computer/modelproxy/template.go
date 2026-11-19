// Header templates and globs, the two small languages of a profile
// (profile.go): a header value with {variables} from the binding, and a
// header glob where `*` matches any run of bytes.
//
// Invariants: matching is ASCII case-insensitive; a template or a variable's
// value can neither end a header nor start one (validHeaderValue).
package main

import (
	"fmt"
	"net/textproto"
	"slices"
	"strings"
)

func headerMatches(values []string, glob string) bool {
	for _, v := range values {
		if globMatch(glob, strings.TrimSpace(v)) {
			return true
		}
		for item := range strings.SplitSeq(v, ",") {
			item, _, _ = strings.Cut(item, ";")
			if globMatch(glob, strings.TrimSpace(item)) {
				return true
			}
		}
	}
	return false
}

// globMatch: pattern (lower case, `*` matches any run) against s, ASCII
// case-insensitive.
func globMatch(pattern, s string) bool {
	for {
		star := strings.IndexByte(pattern, '*')
		if star < 0 {
			return strings.EqualFold(pattern, s)
		}
		if len(s) < star || !strings.EqualFold(pattern[:star], s[:star]) {
			return false
		}
		pattern, s = pattern[star+1:], s[star:]
		if pattern == "" {
			return true
		}
		next := strings.IndexByte(pattern, '*')
		if next < 0 {
			return len(s) >= len(pattern) && strings.EqualFold(pattern, s[len(s)-len(pattern):])
		}
		i := indexFold(s, pattern[:next])
		if i < 0 {
			return false
		}
		s = s[i:]
	}
}

func indexFold(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if strings.EqualFold(s[i:i+len(sub)], sub) {
			return i
		}
	}
	return -1
}

// matchesAny: one of the lower-case header-name globs matches name.
func matchesAny(globs []string, name string) bool {
	for _, g := range globs {
		if globMatch(g, name) {
			return true
		}
	}
	return false
}

func headerGlobs(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	for _, g := range in {
		if !validHeaderName(strings.ReplaceAll(g, "*", "x")) {
			return nil, fmt.Errorf("bad header glob %q", g)
		}
		out = append(out, strings.ToLower(g))
	}
	return out, nil
}

func headerTemplates(in map[string]string, used map[string]bool) ([]headerValue, error) {
	out := make([]headerValue, 0, len(in))
	for name, v := range in {
		if !validHeaderName(name) {
			return nil, fmt.Errorf("bad header %q", name)
		}
		t, err := parseTemplate(v, used)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		out = append(out, headerValue{name: textproto.CanonicalMIMEHeaderKey(name), value: t})
	}
	sortHeaders(out)
	return out, nil
}

func sortHeaders(h []headerValue) {
	slices.SortFunc(h, func(a, b headerValue) int { return strings.Compare(a.name, b.name) })
}

// template is a header value with {variables}: literal parts alternate with
// variable names, starting with a literal.
type template struct {
	parts []string // parts[0], vars[0], parts[1], vars[1], ..., parts[n]
	vars  []string
}

func parseTemplate(s string, used map[string]bool) (*template, error) {
	if !validHeaderValue(s) {
		return nil, fmt.Errorf("not a header value")
	}
	t := &template{}
	for {
		open := strings.IndexByte(s, '{')
		if open < 0 {
			if strings.IndexByte(s, '}') >= 0 {
				return nil, fmt.Errorf("unmatched }")
			}
			t.parts = append(t.parts, s)
			return t, nil
		}
		end := strings.IndexByte(s, '}')
		if end < open || !isName(s[open+1:end], "_") {
			return nil, fmt.Errorf("write variables as {name}")
		}
		t.parts = append(t.parts, s[:open])
		t.vars = append(t.vars, s[open+1:end])
		used[s[open+1:end]] = true
		s = s[end+1:]
	}
}

func (t *template) expand(vars map[string]string) string {
	if len(t.vars) == 0 {
		return t.parts[0]
	}
	var b strings.Builder
	for i, v := range t.vars {
		b.WriteString(t.parts[i])
		b.WriteString(vars[v])
	}
	b.WriteString(t.parts[len(t.vars)])
	return b.String()
}

// isName: non-empty, ASCII letters and digits plus the bytes in extra.
func isName(s, extra string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte(extra, c) >= 0) {
			return false
		}
	}
	return true
}

func validHeaderName(s string) bool { return isName(s, "-_") }

// validHeaderValue: printable, so it can neither end a header nor start one.
func validHeaderValue(s string) bool {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c < 0x20 && c != '\t' || c == 0x7f {
			return false
		}
	}
	return true
}
