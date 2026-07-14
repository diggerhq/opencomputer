// Package fluebuild validates, builds, and packages a Flue application without
// authenticating to or calling any OpenComputer service.
//
// It is shared by the local `oc agent deploy` flow and the managed repository
// builder. Keep the Deployment type as the single Go representation of the
// deployment.json handoff contract: the deploy runner must not reconstruct it
// from loosely typed maps.
package fluebuild

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/Masterminds/semver/v3"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/bundle"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/credscan"
)

const (
	SchemaVersion      = 1
	TargetCloudflare   = "cloudflare"
	BundleFilename     = "bundle.tgz"
	DeploymentFilename = "deployment.json"
	BuildOutputDir     = "dist"
	BundleMaxBytes     = 64 << 20
)

var (
	bindingIdentifier = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)
	compatibilityFlag = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	bundleDigest      = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

// Deployment is the versioned, byte-free metadata written to deployment.json.
// Wrangler and Bundle are absent only from a --check-only projection.
type Deployment struct {
	SchemaVersion int     `json:"schema_version"`
	Flue          Flue    `json:"flue"`
	Model         string  `json:"model"`
	Vars          Vars    `json:"vars"`
	Runtime       Runtime `json:"runtime"`
	Bundle        *Bundle `json:"bundle,omitempty"`
	Builder       Builder `json:"builder"`
}

type Flue struct {
	Entrypoint string              `json:"entrypoint"`
	Wrangler   *WranglerDescriptor `json:"wrangler,omitempty"`
}

type Runtime struct {
	Family string `json:"family" toml:"family"`
	Type   string `json:"type" toml:"type"`
}

type Bundle struct {
	Digest    string `json:"digest"`
	SizeBytes int64  `json:"size_bytes"`
}

type Builder struct {
	Version string `json:"version"`
}

// Vars is named so callers cannot accidentally replace the manifest-derived
// snapshot with an untyped map. Values are non-secret strings from agent.toml.
type Vars map[string]string

type DOBinding struct {
	Name      string `json:"name"`
	ClassName string `json:"class_name"`
}

// WranglerDescriptor is the strict Worker-for-Platforms subset accepted from
// Flue's generated wrangler.json. Raw Wrangler configuration never crosses the
// builder boundary.
type WranglerDescriptor struct {
	Main               string   `json:"main"`
	CompatibilityDate  string   `json:"compatibility_date"`
	CompatibilityFlags []string `json:"compatibility_flags"`
	NoBundle           bool     `json:"no_bundle"`
	DurableObjects     struct {
		Bindings []DOBinding `json:"bindings"`
	} `json:"durable_objects"`
}

type manifest struct {
	Name    string  `toml:"name"`
	Model   string  `toml:"model"`
	Vars    Vars    `toml:"vars"`
	Runtime Runtime `toml:"runtime"`
}

type packageJSON struct {
	Engines         map[string]string `json:"engines"`
	Dependencies    map[string]string `json:"dependencies"`
	DevDependencies map[string]string `json:"devDependencies"`
}

type packageLockJSON struct {
	LockfileVersion int `json:"lockfileVersion"`
}

type generatedWrangler struct {
	Main               string   `json:"main"`
	CompatibilityDate  string   `json:"compatibility_date"`
	CompatibilityFlags []string `json:"compatibility_flags"`
	NoBundle           bool     `json:"no_bundle"`
	DurableObjects     struct {
		Bindings []json.RawMessage `json:"bindings"`
	} `json:"durable_objects"`
}

// Options controls one offline build. NodeVersion may be supplied by a pinned
// builder snapshot; when empty, the local node binary is queried. OutputDir is
// optional for in-process callers such as `oc agent deploy`.
type Options struct {
	Dir            string
	Target         string
	OutputDir      string
	BuilderVersion string
	NodeVersion    string
	CheckOnly      bool
	BuildStdout    io.Writer
	BuildStderr    io.Writer
}

type Result struct {
	Deployment Deployment
	Bundle     []byte
}

// CredentialError reports redacted credential findings from either source or
// built modules. It deliberately retains typed findings for CLI presentation.
type CredentialError struct {
	Stage    string
	Findings []credscan.Finding
}

func (e *CredentialError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "possible credential(s) in %s", e.Stage)
	for _, finding := range e.Findings {
		fmt.Fprintf(&b, "\n  %s:%d  %s  %s", finding.Path, finding.Line, finding.Kind, finding.Match)
	}
	return b.String()
}

// Build validates the repository projection and, unless CheckOnly is set,
// invokes the repository-local Flue CLI and returns the canonical artifact.
// This function performs no source fetch, network request, API authentication,
// upload, or deployment. Repository code executed by Flue is untrusted and must
// be isolated by the caller.
func Build(ctx context.Context, opts Options) (Result, error) {
	if strings.TrimSpace(opts.Dir) == "" {
		opts.Dir = "."
	}
	if opts.Target == "" {
		opts.Target = TargetCloudflare
	}
	if opts.Target != TargetCloudflare {
		return Result{}, fmt.Errorf("unsupported target %q (only %q is supported)", opts.Target, TargetCloudflare)
	}
	if opts.BuilderVersion == "" {
		opts.BuilderVersion = "dev"
	}
	if !strings.HasPrefix(opts.BuilderVersion, "oc@") {
		opts.BuilderVersion = "oc@" + opts.BuilderVersion
	}

	projection, err := inspect(ctx, opts.Dir, opts.BuilderVersion, opts.NodeVersion)
	if err != nil {
		return Result{}, err
	}
	if opts.CheckOnly {
		if err := ValidateDeployment(projection, false); err != nil {
			return Result{}, err
		}
		return Result{Deployment: projection}, nil
	}

	stdout := opts.BuildStdout
	if stdout == nil {
		stdout = os.Stderr
	}
	stderr := opts.BuildStderr
	if stderr == nil {
		stderr = os.Stderr
	}
	if err := RunFlue(ctx, opts.Dir, stdout, stderr); err != nil {
		return Result{}, err
	}

	files, wrangler, err := ReadBundle(filepath.Join(opts.Dir, BuildOutputDir))
	if err != nil {
		return Result{}, err
	}
	if err := scanBuiltModules(files); err != nil {
		return Result{}, err
	}
	tarGz, err := bundle.Pack(files)
	if err != nil {
		return Result{}, fmt.Errorf("pack bundle: %w", err)
	}
	if len(tarGz) > BundleMaxBytes {
		return Result{}, fmt.Errorf("bundle is %d bytes, over the %d MiB limit", len(tarGz), BundleMaxBytes>>20)
	}

	projection.Flue.Wrangler = &wrangler
	projection.Bundle = &Bundle{
		Digest:    bundle.Digest(tarGz),
		SizeBytes: int64(len(tarGz)),
	}
	result := Result{Deployment: projection, Bundle: tarGz}
	if err := ValidateDeployment(result.Deployment, true); err != nil {
		return Result{}, err
	}
	if opts.OutputDir != "" {
		if err := WriteOutput(opts.OutputDir, result); err != nil {
			return Result{}, err
		}
	}
	return result, nil
}

// ParseDeployment decodes deployment.json with unknown-field rejection, then
// validates either the check-only projection or the complete artifact shape.
func ParseDeployment(raw []byte, requireArtifact bool) (Deployment, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var deployment Deployment
	if err := decoder.Decode(&deployment); err != nil {
		return Deployment{}, fmt.Errorf("decode deployment metadata: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Deployment{}, fmt.Errorf("decode deployment metadata: trailing JSON value")
	}
	if err := ValidateDeployment(deployment, requireArtifact); err != nil {
		return Deployment{}, err
	}
	return deployment, nil
}

// ValidateDeployment enforces the frozen schema independently of Build so an
// artifact consumer can fail closed before trusting the handoff metadata.
func ValidateDeployment(deployment Deployment, requireArtifact bool) error {
	if deployment.SchemaVersion != SchemaVersion {
		return fmt.Errorf("deployment schema_version %d is unsupported", deployment.SchemaVersion)
	}
	if strings.TrimSpace(deployment.Flue.Entrypoint) == "" {
		return fmt.Errorf("deployment flue.entrypoint is required")
	}
	if strings.TrimSpace(deployment.Model) == "" {
		return fmt.Errorf("deployment model is required")
	}
	if deployment.Vars == nil {
		return fmt.Errorf("deployment vars must be an object")
	}
	if deployment.Runtime.Family != "flue" || deployment.Runtime.Type != "default" {
		return fmt.Errorf("deployment runtime must be family=%q, type=%q", "flue", "default")
	}
	if !strings.HasPrefix(deployment.Builder.Version, "oc@") || strings.TrimPrefix(deployment.Builder.Version, "oc@") == "" {
		return fmt.Errorf("deployment builder.version must use oc@<version>")
	}
	if !requireArtifact {
		if deployment.Flue.Wrangler != nil || deployment.Bundle != nil {
			return fmt.Errorf("check-only deployment must omit flue.wrangler and bundle")
		}
		return nil
	}
	if deployment.Flue.Wrangler == nil || deployment.Bundle == nil {
		return fmt.Errorf("complete deployment requires flue.wrangler and bundle")
	}
	if !bundleDigest.MatchString(deployment.Bundle.Digest) || deployment.Bundle.SizeBytes <= 0 || deployment.Bundle.SizeBytes > BundleMaxBytes {
		return fmt.Errorf("deployment bundle digest/size is invalid")
	}
	wranglerJSON, err := json.Marshal(deployment.Flue.Wrangler)
	if err != nil {
		return fmt.Errorf("encode deployment wrangler: %w", err)
	}
	if _, err := ExtractWranglerDescriptor(wranglerJSON); err != nil {
		return fmt.Errorf("deployment flue.wrangler: %w", err)
	}
	return nil
}

func inspect(ctx context.Context, dir, builderVersion, nodeVersion string) (Deployment, error) {
	findings, err := credscan.ScanDir(dir)
	if err != nil {
		return Deployment{}, fmt.Errorf("credential scan: %w", err)
	}
	if len(findings) > 0 {
		return Deployment{}, &CredentialError{Stage: "source", Findings: findings}
	}

	manifestBytes, err := readRequiredRegularFile(dir, "agent.toml", 1<<20)
	if err != nil {
		return Deployment{}, err
	}
	var m manifest
	if _, err := toml.Decode(string(manifestBytes), &m); err != nil {
		return Deployment{}, fmt.Errorf("parse agent.toml: %w", err)
	}
	if strings.TrimSpace(m.Name) == "" {
		return Deployment{}, fmt.Errorf("agent.toml needs a `name` Flue entrypoint")
	}
	if strings.TrimSpace(m.Model) == "" {
		return Deployment{}, fmt.Errorf("agent.toml needs a `model`")
	}
	if m.Runtime.Family != "flue" {
		return Deployment{}, fmt.Errorf("agent.toml runtime.family must be %q", "flue")
	}
	if m.Runtime.Type == "" {
		m.Runtime.Type = "default"
	}
	if m.Runtime.Type != "default" {
		return Deployment{}, fmt.Errorf("agent.toml runtime.type %q is unsupported; managed Flue currently requires %q", m.Runtime.Type, "default")
	}
	if m.Vars == nil {
		m.Vars = Vars{}
	}

	packageBytes, err := readRequiredRegularFile(dir, "package.json", 2<<20)
	if err != nil {
		return Deployment{}, err
	}
	var pkg packageJSON
	if err := json.Unmarshal(packageBytes, &pkg); err != nil {
		return Deployment{}, fmt.Errorf("parse package.json: %w", err)
	}
	flueVersion := pkg.DevDependencies["@flue/cli"]
	if flueVersion == "" {
		flueVersion = pkg.Dependencies["@flue/cli"]
	}
	if strings.TrimSpace(flueVersion) == "" {
		return Deployment{}, fmt.Errorf("package.json must declare a local @flue/cli dependency")
	}
	nodeEngine := strings.TrimSpace(pkg.Engines["node"])
	if nodeEngine == "" {
		return Deployment{}, fmt.Errorf("package.json must declare engines.node")
	}
	if nodeVersion == "" {
		nodeVersion, err = installedNodeVersion(ctx)
		if err != nil {
			return Deployment{}, err
		}
	}
	if err := validateNodeEngine(nodeEngine, nodeVersion); err != nil {
		return Deployment{}, err
	}

	lockBytes, err := readRequiredRegularFile(dir, "package-lock.json", 25<<20)
	if err != nil {
		return Deployment{}, err
	}
	var lock packageLockJSON
	if err := json.Unmarshal(lockBytes, &lock); err != nil {
		return Deployment{}, fmt.Errorf("parse package-lock.json: %w", err)
	}
	if lock.LockfileVersion != 2 && lock.LockfileVersion != 3 {
		return Deployment{}, fmt.Errorf("package-lock.json lockfileVersion %d is unsupported (expected 2 or 3)", lock.LockfileVersion)
	}

	return Deployment{
		SchemaVersion: SchemaVersion,
		Flue:          Flue{Entrypoint: m.Name},
		Model:         m.Model,
		Vars:          m.Vars,
		Runtime:       m.Runtime,
		Builder:       Builder{Version: builderVersion},
	}, nil
}

func readRequiredRegularFile(root, name string, maxBytes int64) ([]byte, error) {
	path := filepath.Join(root, name)
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("required file %s is missing", name)
		}
		return nil, fmt.Errorf("inspect %s: %w", name, err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("required file %s must be a regular file", name)
	}
	if info.Size() > maxBytes {
		return nil, fmt.Errorf("required file %s is %d bytes, over the %d byte limit", name, info.Size(), maxBytes)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", name, err)
	}
	return content, nil
}

func installedNodeVersion(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, "node", "--version")
	cmd.Stdin = nil
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("read node version: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

func validateNodeEngine(constraint, nodeVersion string) error {
	version, err := semver.NewVersion(strings.TrimPrefix(strings.TrimSpace(nodeVersion), "v"))
	if err != nil {
		return fmt.Errorf("invalid builder node version %q: %w", nodeVersion, err)
	}
	rangeConstraint, err := semver.NewConstraint(constraint)
	if err != nil {
		return fmt.Errorf("invalid package.json engines.node %q: %w", constraint, err)
	}
	if !rangeConstraint.Check(version) {
		return fmt.Errorf("node_unsupported: package engines.node %q does not admit builder node %s", constraint, version.String())
	}
	return nil
}

// RunFlue invokes only an already-installed repository-local Flue CLI. The
// npx fallback has --no-install, so this helper never fetches a package.
func RunFlue(ctx context.Context, dir string, stdout, stderr io.Writer) error {
	args := []string{"build", "--target", TargetCloudflare}
	bin, err := filepath.Abs(filepath.Join(dir, "node_modules", ".bin", "flue"))
	if err != nil {
		return fmt.Errorf("resolve local flue binary: %w", err)
	}
	var cmd *exec.Cmd
	if _, err := os.Stat(bin); err == nil {
		cmd = exec.CommandContext(ctx, bin, args...)
	} else {
		cmd = exec.CommandContext(ctx, "npx", append([]string{"--no-install", "flue"}, args...)...)
	}
	cmd.Dir = dir
	cmd.Env = BuildEnv()
	cmd.Stdin = nil
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("flue build failed: %w\n(run `npm install` so the flue CLI is available and use a supported Node version)", err)
	}
	return nil
}

// BuildEnv keeps non-actionable direct-Wrangler warnings out of output while
// preserving an explicit debugging override.
func BuildEnv() []string {
	const key = "WRANGLER_LOG"
	const fallback = key + "=error"
	env := os.Environ()
	prefix := key + "="
	for i, value := range env {
		if !strings.HasPrefix(value, prefix) {
			continue
		}
		if value == prefix {
			env[i] = fallback
		}
		return env
	}
	return append(env, fallback)
}

// ReadBundle extracts a strict descriptor and only regular JavaScript modules
// from Flue's build output.
func ReadBundle(distDir string) ([]bundle.File, WranglerDescriptor, error) {
	wranglerPath, err := findGeneratedWrangler(distDir)
	if err != nil {
		return nil, WranglerDescriptor{}, err
	}
	raw, err := os.ReadFile(wranglerPath)
	if err != nil {
		return nil, WranglerDescriptor{}, fmt.Errorf("read %s: %w", wranglerPath, err)
	}
	wrangler, err := ExtractWranglerDescriptor(raw)
	if err != nil {
		return nil, WranglerDescriptor{}, fmt.Errorf("parse %s: %w", wranglerPath, err)
	}

	bundleRoot := filepath.Dir(wranglerPath)
	files, err := ReadBundleModules(bundleRoot)
	if err != nil {
		return nil, WranglerDescriptor{}, err
	}
	found := false
	for _, file := range files {
		if file.Path == wrangler.Main {
			found = true
			break
		}
	}
	if !found {
		return nil, WranglerDescriptor{}, fmt.Errorf("entry module %q (wrangler.main) is not in the module output %s", wrangler.Main, bundleRoot)
	}
	return files, wrangler, nil
}

func safeModulePath(value string) bool {
	if value == "" || strings.HasPrefix(value, "/") || strings.Contains(value, `\`) {
		return false
	}
	if ext := pathpkg.Ext(value); ext != ".js" && ext != ".mjs" {
		return false
	}
	if pathpkg.Clean(value) != value {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func ExtractWranglerDescriptor(raw []byte) (WranglerDescriptor, error) {
	var generated generatedWrangler
	if err := json.Unmarshal(raw, &generated); err != nil {
		return WranglerDescriptor{}, err
	}
	if !safeModulePath(generated.Main) {
		return WranglerDescriptor{}, fmt.Errorf("main must be a safe relative .js/.mjs module path")
	}
	if parsed, err := time.Parse("2006-01-02", generated.CompatibilityDate); err != nil || parsed.Format("2006-01-02") != generated.CompatibilityDate {
		return WranglerDescriptor{}, fmt.Errorf("compatibility_date must be a valid YYYY-MM-DD date")
	}
	if generated.CompatibilityFlags == nil || len(generated.CompatibilityFlags) > 64 {
		return WranglerDescriptor{}, fmt.Errorf("compatibility_flags must be a unique array of valid flag names")
	}
	seenFlags := map[string]bool{}
	for _, flag := range generated.CompatibilityFlags {
		if !compatibilityFlag.MatchString(flag) || seenFlags[flag] {
			return WranglerDescriptor{}, fmt.Errorf("compatibility_flags must be a unique array of valid flag names")
		}
		seenFlags[flag] = true
	}
	if !generated.NoBundle {
		return WranglerDescriptor{}, fmt.Errorf("no_bundle must be true")
	}

	bindings := make([]DOBinding, 0, len(generated.DurableObjects.Bindings))
	names := map[string]bool{}
	classes := map[string]bool{}
	for _, rawBinding := range generated.DurableObjects.Bindings {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(rawBinding, &fields); err != nil {
			return WranglerDescriptor{}, fmt.Errorf("invalid durable-object binding: %w", err)
		}
		if len(fields) != 2 || fields["name"] == nil || fields["class_name"] == nil {
			return WranglerDescriptor{}, fmt.Errorf("durable-object bindings may contain only name and class_name")
		}
		var binding DOBinding
		if err := json.Unmarshal(rawBinding, &binding); err != nil {
			return WranglerDescriptor{}, fmt.Errorf("invalid durable-object binding: %w", err)
		}
		if !bindingIdentifier.MatchString(binding.Name) || !bindingIdentifier.MatchString(binding.ClassName) {
			return WranglerDescriptor{}, fmt.Errorf("durable-object binding names and class names must be non-empty JavaScript identifiers")
		}
		if names[binding.Name] || classes[binding.ClassName] {
			return WranglerDescriptor{}, fmt.Errorf("durable-object binding names and class names must be unique")
		}
		names[binding.Name] = true
		classes[binding.ClassName] = true
		bindings = append(bindings, binding)
	}
	if len(bindings) == 0 {
		return WranglerDescriptor{}, fmt.Errorf("at least one same-script durable-object binding is required")
	}

	var descriptor WranglerDescriptor
	descriptor.Main = generated.Main
	descriptor.CompatibilityDate = generated.CompatibilityDate
	descriptor.CompatibilityFlags = append([]string(nil), generated.CompatibilityFlags...)
	descriptor.NoBundle = true
	descriptor.DurableObjects.Bindings = bindings
	return descriptor, nil
}

func findGeneratedWrangler(distDir string) (string, error) {
	if info, err := os.Stat(distDir); err != nil || !info.IsDir() {
		return "", fmt.Errorf("build output %s not found — did `flue build --target cloudflare` run?", distDir)
	}
	flat := filepath.Join(distDir, "wrangler.json")
	if _, err := os.Stat(flat); err == nil {
		return flat, nil
	}
	matches, _ := filepath.Glob(filepath.Join(distDir, "*", "wrangler.json"))
	switch len(matches) {
	case 0:
		return "", fmt.Errorf("no wrangler.json under %s — `flue build --target cloudflare` produced no Cloudflare build", distDir)
	case 1:
		return matches[0], nil
	default:
		return "", fmt.Errorf("multiple wrangler.json under %s (%v) — ambiguous flue build output", distDir, matches)
	}
}

// ReadBundleModules walks one generated output into a normalized module-only
// fileset. Unsafe links and unrecognized output fail closed.
func ReadBundleModules(root string) ([]bundle.File, error) {
	if info, err := os.Stat(root); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("build output %s not found — did `flue build --target cloudflare` run?", root)
	}
	var files []bundle.File
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if path != root && entry.Name() == ".vite" {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("build output contains symlink %s; only regular modules are allowed", path)
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("build output contains non-regular file %s", path)
		}
		if rel == "wrangler.json" || strings.HasSuffix(rel, ".map") {
			return nil
		}
		if !safeModulePath(rel) {
			return fmt.Errorf("build output contains unsupported file %q; expected only .js/.mjs modules", rel)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files = append(files, bundle.File{
			Path:    rel,
			Mode:    bundle.NormalizeMode(int(info.Mode().Perm())),
			Content: content,
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", root, err)
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("build output %s is empty", root)
	}
	return files, nil
}

func scanBuiltModules(files []bundle.File) error {
	var findings []credscan.Finding
	for _, file := range files {
		findings = append(findings, credscan.ScanBytes(file.Path, file.Content)...)
	}
	if len(findings) > 0 {
		return &CredentialError{Stage: "built modules", Findings: findings}
	}
	return nil
}

// WriteOutput atomically replaces the two files in the offline artifact
// contract. It never writes source paths or bundle bytes into deployment.json.
func WriteOutput(outputDir string, result Result) error {
	if err := ValidateDeployment(result.Deployment, true); err != nil {
		return err
	}
	if int64(len(result.Bundle)) != result.Deployment.Bundle.SizeBytes || bundle.Digest(result.Bundle) != result.Deployment.Bundle.Digest {
		return fmt.Errorf("bundle bytes do not match deployment metadata")
	}
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return fmt.Errorf("create output directory: %w", err)
	}
	info, err := os.Lstat(outputDir)
	if err != nil {
		return fmt.Errorf("inspect output directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("output must be a real directory, not a link")
	}
	metadata, err := json.MarshalIndent(result.Deployment, "", "  ")
	if err != nil {
		return fmt.Errorf("encode deployment metadata: %w", err)
	}
	metadata = append(metadata, '\n')
	if err := atomicWrite(filepath.Join(outputDir, BundleFilename), result.Bundle, 0o644); err != nil {
		return err
	}
	if err := atomicWrite(filepath.Join(outputDir, DeploymentFilename), metadata, 0o644); err != nil {
		return err
	}
	return nil
}

func atomicWrite(path string, content []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".oc-build-*")
	if err != nil {
		return fmt.Errorf("create temporary output: %w", err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("replace %s: %w", filepath.Base(path), err)
	}
	return nil
}
