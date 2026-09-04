package api

import (
	"encoding/base64"
	"strings"
	"testing"
)

func render(t *testing.T, steps ...ImageStep) string {
	t.Helper()
	out, _, err := RenderMicrovmDockerfile(ImageManifest{Base: "base", Steps: steps})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	return out
}

// The sandwich is the whole security model: the customer supplies the middle,
// and no manifest can reach FROM, the agent binaries or ENTRYPOINT. If this
// breaks, a template can produce a box that never becomes ready — or worse,
// one running something other than our agent.
func TestCustomerLayersCannotEscapeTheSandwich(t *testing.T) {
	out := render(t, ImageStep{
		Type: "run",
		Args: map[string]interface{}{"commands": []interface{}{
			"echo hi",
			"FROM scratch", // only ever a shell arg, never an instruction
			`ENTRYPOINT ["/bin/false"]`,
		}},
	})

	if strings.Count(out, "\nFROM ") != 1 {
		t.Errorf("expected exactly one FROM instruction, got %d", strings.Count(out, "\nFROM "))
	}
	entry := strings.Index(out, `ENTRYPOINT ["/usr/local/bin/microvm-hooks"]`)
	if entry < 0 {
		t.Fatal("our ENTRYPOINT is missing")
	}
	// Ours must be the LAST ENTRYPOINT: Docker honours the final one.
	if last := strings.LastIndex(out, "\nENTRYPOINT "); last+1 != entry {
		t.Errorf("our ENTRYPOINT is not the last one (ours at %d, last at %d)", entry, last+1)
	}
	// The agent must be copied in after the customer's layers, so no customer
	// step can delete or shadow it.
	custom := strings.Index(out, "customer template layers")
	copyAgent := strings.Index(out, "COPY osb-agent")
	if custom < 0 || copyAgent < 0 || copyAgent < custom {
		t.Errorf("agent COPY (%d) must come after customer layers (%d)", copyAgent, custom)
	}
}

// pip must run ABOVE `ENV PIP_USER=1`. Below it, a build-time `pip install`
// lands in /root/.local and is invisible to the sandbox user at runtime — the
// template appears to build fine and then does nothing.
func TestPipInstallRendersAboveThePipUserEnv(t *testing.T) {
	out := render(t, ImageStep{
		Type: "pip_install",
		Args: map[string]interface{}{"packages": []interface{}{"pandas"}},
	})
	pip := strings.Index(out, "pip3 install --no-cache-dir pandas")
	env := strings.Index(out, "ENV PIP_USER=1")
	if pip < 0 || env < 0 {
		t.Fatalf("missing pip step (%d) or PIP_USER env (%d)", pip, env)
	}
	if pip > env {
		t.Error("pip install renders BELOW ENV PIP_USER=1 — it would install into /root/.local and be invisible to the sandbox user")
	}
}

func TestAptPackagesAreMappedToAL2023(t *testing.T) {
	out := render(t, ImageStep{
		Type: "apt_install",
		Args: map[string]interface{}{"packages": []interface{}{"build-essential", "python3-dev", "ffmpeg"}},
	})
	if !strings.Contains(out, "dnf install -y") {
		t.Fatal("expected dnf, not apt")
	}
	if strings.Contains(out, "apt-get") {
		t.Error("apt-get leaked into a microvm Dockerfile")
	}
	for _, want := range []string{"gcc", "gcc-c++", "make", "python3-devel", "ffmpeg"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing mapped package %q in: %s", want, out)
		}
	}
	if strings.Contains(out, "build-essential") || strings.Contains(out, "python3-dev ") {
		t.Error("unmapped Debian package name survived into the Dockerfile")
	}
}

// A package name is a package name. Anything that could append a second command
// to the RUN line is rejected rather than quoted.
func TestPackageNamesRejectShellMetacharacters(t *testing.T) {
	for _, bad := range []string{"git; rm -rf /", "a$(id)", "a`id`", "a b", "a|b"} {
		_, _, err := RenderMicrovmDockerfile(ImageManifest{Steps: []ImageStep{{
			Type: "apt_install",
			Args: map[string]interface{}{"packages": []interface{}{bad}},
		}}})
		if err == nil {
			t.Errorf("package %q was accepted", bad)
		}
	}
}

// The build is content-hash cached upstream, so an unchanged manifest must
// render byte-identically. Go map iteration order would silently break that.
func TestEnvRenderingIsDeterministic(t *testing.T) {
	step := ImageStep{Type: "env", Args: map[string]interface{}{
		"vars": map[string]interface{}{"B": "2", "A": "1", "C": "3", "D": "4", "E": "5"},
	}}
	first := render(t, step)
	for i := 0; i < 20; i++ {
		if got := render(t, step); got != first {
			t.Fatal("env rendering is not deterministic across runs")
		}
	}
	if !strings.Contains(first, `ENV A="1"`) {
		t.Errorf("unexpected env rendering: %s", first)
	}
}

func TestAddFileEmitsCopyAndBuildContext(t *testing.T) {
	out, files, err := RenderMicrovmDockerfile(ImageManifest{Steps: []ImageStep{{
		Type: "add_file",
		// decodeBuildFileContent requires base64 — the SDK encodes file bodies.
		Args: map[string]interface{}{"path": "/opt/app/config.json", "content": base64.StdEncoding.EncodeToString([]byte(`{"k":1}`))},
	}}})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("expected 1 build-context file, got %d", len(files))
	}
	if !strings.Contains(out, "COPY "+files[0].ContextPath) {
		t.Errorf("COPY does not reference the emitted context path %q", files[0].ContextPath)
	}
	if string(files[0].Content) != `{"k":1}` {
		t.Errorf("content mismatch: %q", files[0].Content)
	}
}

// Silently dropping a step the runtime cannot honour would produce an image
// missing the customer's files with a successful build.
func TestUnsupportedStepIsAnErrorNotASilentDrop(t *testing.T) {
	_, _, err := RenderMicrovmDockerfile(ImageManifest{Steps: []ImageStep{
		{Type: "add_dir", Args: map[string]interface{}{"localPath": "/tmp/x"}},
	}})
	if err == nil {
		t.Fatal("add_dir was silently accepted")
	}
	if !strings.Contains(err.Error(), "add_dir") {
		t.Errorf("error should name the step: %v", err)
	}
}

// An empty manifest must still yield a valid, buildable base image.
func TestEmptyManifestRendersTheBaseImageUnchanged(t *testing.T) {
	out := render(t)
	if strings.Contains(out, "customer template layers") {
		t.Error("empty manifest emitted a customer-layer section")
	}
	for _, want := range []string{"FROM ", "COPY osb-agent", `ENTRYPOINT ["/usr/local/bin/microvm-hooks"]`} {
		if !strings.Contains(out, want) {
			t.Errorf("base image lost %q", want)
		}
	}
}
