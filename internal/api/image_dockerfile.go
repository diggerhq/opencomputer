package api

import (
	"fmt"
	"path"
	"sort"
	"strings"

	microvmimage "github.com/opensandbox/opensandbox/deploy/microvm"
)

// Compiling an ImageManifest for the MicroVM runtime.
//
// The QEMU runtime builds a template by booting a sandbox, running each step as
// a shell command, and checkpointing the result — and that works there because a
// QEMU checkpoint captures the whole ROOTFS. The MicroVM runtime cannot do this:
// /oc/workspace/export archives /home/sandbox and nothing else, so a
// `dnf install` into /usr is gone the moment the box dies. Anything that must
// survive outside the home directory has to be baked into the image itself.
//
// Lambda MicroVMs builds images from a Dockerfile it runs on its own
// infrastructure, so the manifest compiles to Dockerfile lines here instead of
// to shell commands. Same customer-facing manifest, different machinery —
// translateStepToCommand is the sibling of this function, not its replacement.

// BuildFile is a file that must be placed in the build context ZIP alongside
// the Dockerfile, for a COPY line to pick up.
type BuildFile struct {
	// ContextPath is the path within the ZIP (and the COPY source).
	ContextPath string
	Content     []byte
}

// aptToDNF maps Debian/Ubuntu package names to their AL2023 equivalents.
//
// The manifest is the same on both runtimes, so aptInstall(["build-essential"])
// is a request a customer can legitimately make — but that package does not
// exist on AL2023, and `dnf install -y build-essential` fails the whole image
// build with an error naming a package the customer did not think they were
// installing. Mapping the common ones keeps a QEMU template re-buildable on
// MicroVM unchanged; anything unmapped passes through, and dnf's own
// "No match for argument" is a clearer error than anything invented here.
var aptToDNF = map[string][]string{
	"build-essential": {"gcc", "gcc-c++", "make"},
	"python3-dev":     {"python3-devel"},
	"python3-pip":     {"python3-pip"},
	"libffi-dev":      {"libffi-devel"},
	"libssl-dev":      {"openssl-devel"},
	"zlib1g-dev":      {"zlib-devel"},
	"libsqlite3-dev":  {"sqlite-devel"},
	"pkg-config":      {"pkgconf-pkg-config"},
	"netcat":          {"nmap-ncat"},
	"iputils-ping":    {"iputils"},
	"dnsutils":        {"bind-utils"},
	"vim":             {"vim-minimal"},
	"procps":          {"procps-ng"},
}

func mapAptPackages(pkgs []string) []string {
	out := make([]string, 0, len(pkgs))
	seen := map[string]bool{}
	for _, p := range pkgs {
		mapped, ok := aptToDNF[strings.ToLower(strings.TrimSpace(p))]
		if !ok {
			mapped = []string{p}
		}
		for _, m := range mapped {
			if !seen[m] {
				seen[m] = true
				out = append(out, m)
			}
		}
	}
	return out
}

// RenderMicrovmDockerfile compiles a manifest into a Dockerfile plus the build
// context files its COPY lines reference.
//
// The customer contributes only the middle: the prologue and epilogue come from
// the real base image definition (deploy/microvm/Dockerfile), so FROM, the agent
// binaries, the sandbox user and ENTRYPOINT are always ours and always last.
// That is a structural guarantee rather than a validation pass — there is no
// customer input that can reach them.
func RenderMicrovmDockerfile(m ImageManifest) (string, []BuildFile, error) {
	prologue, epilogue, err := microvmimage.Split()
	if err != nil {
		return "", nil, err
	}

	var b strings.Builder
	var files []BuildFile

	for i, step := range m.Steps {
		line, stepFiles, err := renderStep(i, step)
		if err != nil {
			return "", nil, fmt.Errorf("step %d (%s): %w", i, step.Type, err)
		}
		if line != "" {
			b.WriteString(line)
			b.WriteString("\n")
		}
		files = append(files, stepFiles...)
	}

	custom := b.String()
	if custom != "" {
		custom = "\n# ---- customer template layers ----\n" + custom
	}
	return prologue + custom + epilogue, files, nil
}

func renderStep(idx int, step ImageStep) (string, []BuildFile, error) {
	switch step.Type {
	case "apt_install":
		pkgs, err := stepStrings(step, "packages")
		if err != nil {
			return "", nil, err
		}
		mapped := mapAptPackages(pkgs)
		if len(mapped) == 0 {
			return "", nil, fmt.Errorf("no packages")
		}
		if err := validatePackages(mapped); err != nil {
			return "", nil, err
		}
		return fmt.Sprintf("RUN dnf install -y %s && dnf clean all && rm -rf /var/cache/dnf",
			strings.Join(mapped, " ")), nil, nil

	case "pip_install":
		pkgs, err := stepStrings(step, "packages")
		if err != nil {
			return "", nil, err
		}
		if len(pkgs) == 0 {
			return "", nil, fmt.Errorf("no packages")
		}
		if err := validatePackages(pkgs); err != nil {
			return "", nil, err
		}
		// Deliberately a plain system-wide install. The layers are spliced in
		// ABOVE the base image's `ENV PIP_USER=1`, so pip is not in user mode
		// here and this lands in the system site-packages every user can see.
		// Were it to run below that ENV, it would install into /root/.local and
		// be invisible to the sandbox user at runtime.
		return fmt.Sprintf("RUN pip3 install --no-cache-dir %s", strings.Join(pkgs, " ")), nil, nil

	case "run":
		cmds, err := stepStrings(step, "commands")
		if err != nil {
			return "", nil, err
		}
		if len(cmds) == 0 {
			return "", nil, fmt.Errorf("no commands")
		}
		// No `sudo`: Dockerfile steps already run as root at build time, and
		// the base image sets no_new_privs so sudo cannot elevate anyway. The
		// QEMU compiler adds sudo because there the steps run as the sandbox
		// user inside a booted box.
		return "RUN " + strings.Join(cmds, " \\\n && "), nil, nil

	case "env":
		vars, ok := step.Args["vars"].(map[string]interface{})
		if !ok {
			return "", nil, fmt.Errorf("vars must be a map")
		}
		keys := make([]string, 0, len(vars))
		for k := range vars {
			keys = append(keys, k)
		}
		// Sorted so the same manifest renders byte-identically every time —
		// the build is content-hash cached upstream, and Go map order would
		// otherwise produce a different hash for an unchanged template.
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			if err := validateEnvKey(k); err != nil {
				return "", nil, err
			}
			parts = append(parts, fmt.Sprintf("%s=%s", k, dockerQuote(fmt.Sprintf("%v", vars[k]))))
		}
		return "ENV " + strings.Join(parts, " \\\n    "), nil, nil

	case "workdir":
		p, ok := step.Args["path"].(string)
		if !ok {
			return "", nil, fmt.Errorf("path must be a string")
		}
		if err := validateAbsoluteBuildPath(p); err != nil {
			return "", nil, err
		}
		return fmt.Sprintf("WORKDIR %s", dockerQuote(p)), nil, nil

	case "add_file":
		p, content, err := parseAddFileStep(step)
		if err != nil {
			return "", nil, err
		}
		ctxPath := fmt.Sprintf("ctx/%d/%s", idx, path.Base(p))
		return fmt.Sprintf("COPY %s %s", ctxPath, dockerQuote(p)),
			[]BuildFile{{ContextPath: ctxPath, Content: content}}, nil

	default:
		// add_dir is intentionally absent until the ZIP packer (CT-3) can carry
		// a directory tree; returning an explicit error beats emitting an image
		// that silently lacks the customer's files.
		return "", nil, fmt.Errorf("unsupported step type %q on the microvm runtime", step.Type)
	}
}

func stepStrings(step ImageStep, key string) ([]string, error) {
	raw, ok := step.Args[key]
	if !ok {
		return nil, fmt.Errorf("missing %s", key)
	}
	return toStringSlice(raw)
}

// validatePackages rejects shell metacharacters in package names rather than
// trying to quote them. A package name is a package name; anything else in that
// position is either a mistake or an attempt to append a second command to the
// RUN line, and neither should reach the build.
func validatePackages(items []string) error {
	for _, s := range items {
		if s == "" {
			return fmt.Errorf("empty package name")
		}
		if strings.ContainsAny(s, "`$;&|<>()\\\"'\n\r \t") {
			return fmt.Errorf("package name %q contains an invalid character", s)
		}
	}
	return nil
}

func validateEnvKey(k string) error {
	if k == "" {
		return fmt.Errorf("empty env key")
	}
	for _, r := range k {
		if !(r == '_' || (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')) {
			return fmt.Errorf("env key %q contains an invalid character", k)
		}
	}
	return nil
}

// dockerQuote renders a value as a double-quoted Dockerfile token. Newlines are
// rejected outright: a raw newline would terminate the instruction and let the
// remainder be parsed as a new one.
func dockerQuote(v string) string {
	if strings.ContainsAny(v, "\n\r") {
		return `""`
	}
	return `"` + strings.ReplaceAll(strings.ReplaceAll(v, `\`, `\\`), `"`, `\"`) + `"`
}
