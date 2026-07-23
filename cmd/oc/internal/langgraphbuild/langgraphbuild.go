// Package langgraphbuild produces a deployable Worker-for-Platforms artifact from a
// LangGraph.js agent project (its wrangler.jsonc + src/app.ts). It is intentionally
// independent of the flue build path (the langgraph runtime is its own thing) but
// emits the SAME artifact shape — a tar.gz of the pre-bundled module + a strict
// wrangler descriptor + a sha256 digest — so the platform hosts a langgraph Worker
// identically to a flue one (model A: the Worker self-hosts its session transport).
package langgraphbuild

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// DOBinding is one Durable Object binding (the session store).
type DOBinding struct {
	Name      string `json:"name"`
	ClassName string `json:"class_name"`
}

// WranglerDescriptor is the strict Worker-for-Platforms subset the platform accepts;
// raw wrangler config never crosses the boundary. NoBundle is always true here — the
// project's own wrangler already produced the final module.
type WranglerDescriptor struct {
	Main               string      `json:"main"`
	CompatibilityDate  string      `json:"compatibility_date"`
	CompatibilityFlags []string    `json:"compatibility_flags"`
	NoBundle           bool        `json:"no_bundle"`
	DurableObjects     struct {
		Bindings []DOBinding `json:"bindings"`
	} `json:"durable_objects"`
}

// Result is the built artifact: the tar.gz bundle bytes plus its content-addressed
// digest and the descriptor referencing it.
type Result struct {
	Wrangler   WranglerDescriptor
	Bundle     []byte
	Digest     string
	SizeBytes  int64
	Entrypoint string // the session Durable Object class the platform routes to
}

type wranglerConfig struct {
	Name               string   `json:"name"`
	Main               string   `json:"main"`
	CompatibilityDate  string   `json:"compatibility_date"`
	CompatibilityFlags []string `json:"compatibility_flags"`
	DurableObjects     struct {
		Bindings []DOBinding `json:"bindings"`
	} `json:"durable_objects"`
}

// Build bundles the project at dir into a Result. It shells out to the project's own
// wrangler (`deploy --dry-run --outdir`) so the bundle honors wrangler.jsonc exactly
// (DO bindings, compatibility flags, nodejs_compat), then tars the emitted module.
func Build(ctx context.Context, dir string) (Result, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "wrangler.jsonc"))
	if err != nil {
		return Result{}, fmt.Errorf("read wrangler.jsonc: %w", err)
	}
	var cfg wranglerConfig
	if err := json.Unmarshal(stripJSONC(raw), &cfg); err != nil {
		return Result{}, fmt.Errorf("parse wrangler.jsonc: %w", err)
	}
	if cfg.Main == "" {
		return Result{}, fmt.Errorf("wrangler.jsonc: missing \"main\"")
	}
	if len(cfg.DurableObjects.Bindings) == 0 {
		return Result{}, fmt.Errorf("wrangler.jsonc: a langgraph agent needs a Durable Object binding (its session store)")
	}

	outDir, err := os.MkdirTemp("", "oc-langgraph-build-*")
	if err != nil {
		return Result{}, err
	}
	defer os.RemoveAll(outDir)

	bin := wranglerBin(dir)
	args := append(bin[1:], "deploy", "--dry-run", "--outdir", outDir)
	c := exec.CommandContext(ctx, bin[0], args...)
	c.Dir = dir
	c.Env = append(os.Environ(), "WRANGLER_SEND_METRICS=false")
	var stderr bytes.Buffer
	c.Stderr = &stderr
	if err := c.Run(); err != nil {
		return Result{}, fmt.Errorf("wrangler bundle failed: %w\n%s", err, strings.TrimSpace(stderr.String()))
	}

	// src/app.ts -> app.js
	mainName := strings.TrimSuffix(filepath.Base(cfg.Main), filepath.Ext(cfg.Main)) + ".js"
	if _, err := os.Stat(filepath.Join(outDir, mainName)); err != nil {
		return Result{}, fmt.Errorf("bundled main %q not found in wrangler output: %w", mainName, err)
	}

	bundle, err := tarGzModules(outDir)
	if err != nil {
		return Result{}, err
	}
	sum := sha256.Sum256(bundle)

	desc := WranglerDescriptor{
		Main:               mainName,
		CompatibilityDate:  cfg.CompatibilityDate,
		CompatibilityFlags: cfg.CompatibilityFlags,
		NoBundle:           true,
	}
	desc.DurableObjects.Bindings = cfg.DurableObjects.Bindings

	return Result{
		Wrangler:   desc,
		Bundle:     bundle,
		Digest:     "sha256:" + hex.EncodeToString(sum[:]),
		SizeBytes:  int64(len(bundle)),
		Entrypoint: cfg.DurableObjects.Bindings[0].ClassName,
	}, nil
}

// wranglerBin prefers the project-local wrangler, falling back to npx.
func wranglerBin(dir string) []string {
	local := filepath.Join(dir, "node_modules", ".bin", "wrangler")
	if _, err := os.Stat(local); err == nil {
		return []string{local}
	}
	return []string{"npx", "--yes", "wrangler"}
}

// tarGzModules tars the emitted *.js module(s) (not sourcemaps) into a gzip archive.
func tarGzModules(dir string) ([]byte, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".js") {
			continue // skip .js.map, README, etc.
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		if err := tw.WriteHeader(&tar.Header{Name: e.Name(), Mode: 0o644, Size: int64(len(data))}); err != nil {
			return nil, err
		}
		if _, err := tw.Write(data); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// stripJSONC removes // line and /* */ block comments so a wrangler.jsonc parses as
// JSON. Simplistic (ignores comment-like sequences inside strings) — fine for the
// generated descriptor; hand-edits with such strings should use plain JSON.
func stripJSONC(b []byte) []byte {
	s := string(b)
	for {
		i := strings.Index(s, "/*")
		if i < 0 {
			break
		}
		j := strings.Index(s[i:], "*/")
		if j < 0 {
			s = s[:i]
			break
		}
		s = s[:i] + s[i+j+2:]
	}
	var out strings.Builder
	for _, line := range strings.Split(s, "\n") {
		if k := strings.Index(line, "//"); k >= 0 {
			line = line[:k]
		}
		out.WriteString(line)
		out.WriteByte('\n')
	}
	return []byte(out.String())
}
