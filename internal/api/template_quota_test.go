package api

import (
	"errors"
	"strings"
	"testing"
)

// Dedupe only works if the same manifest yields the same image name. If this
// ever stops being true, every rebuild takes a fresh image slot and the account
// ceiling arrives ~65 templates later instead of never.
func TestSameManifestSameImageName(t *testing.T) {
	m := ImageManifest{Base: "base", Steps: []ImageStep{
		{Type: "apt_install", Args: map[string]interface{}{"packages": []interface{}{"ffmpeg"}}},
	}}
	h1, h2 := computeManifestHash(&m), computeManifestHash(&m)
	if h1 != h2 {
		t.Fatal("manifest hash is not deterministic")
	}
	org := "86ade78a-7aef-49e3-bc37-b6dfad3ffa92"
	if templateImageName(org, h1) != templateImageName(org, h2) {
		t.Error("identical manifests produced different image names — dedupe would never hit")
	}
}

// ...and a DIFFERENT manifest must not collide, or one customer's template
// silently serves another's environment.
func TestDifferentManifestDifferentImageName(t *testing.T) {
	org := "86ade78a"
	a := ImageManifest{Base: "base", Steps: []ImageStep{{Type: "apt_install", Args: map[string]interface{}{"packages": []interface{}{"ffmpeg"}}}}}
	b := ImageManifest{Base: "base", Steps: []ImageStep{{Type: "apt_install", Args: map[string]interface{}{"packages": []interface{}{"golang"}}}}}
	if templateImageName(org, computeManifestHash(&a)) == templateImageName(org, computeManifestHash(&b)) {
		t.Fatal("different manifests collided on one image name")
	}
}

// Two orgs with the same manifest must not share an image — see the comment on
// FindMicrovmImageTemplateByTag for why per-org is the conservative default.
func TestOrgsDoNotShareAnImageName(t *testing.T) {
	m := ImageManifest{Base: "base"}
	h := computeManifestHash(&m)
	if templateImageName("aaaaaaaa-1111", h) == templateImageName("bbbbbbbb-2222", h) {
		t.Fatal("two orgs mapped to the same image name")
	}
}

// The name is what every destructive path checks before deleting. Anything that
// is not ours must be rejected — this account is shared with a customer-serving
// workload, and `managed-agents-runtime-*` images sit right next to ours.
func TestOnlyOurTemplateImagesAreDeletable(t *testing.T) {
	ours := "arn:aws:lambda:us-east-1:739940681129:microvm-image:" + templateImageName("org1234", "abcdef0123456789")
	if !isOurTemplateImage(ours) {
		t.Error("our own template image was not recognised")
	}
	for _, foreign := range []string{
		"arn:aws:lambda:us-east-1:739940681129:microvm-image:managed-agents-runtime-33700486278-1",
		"arn:aws:lambda:us-east-1:739940681129:microvm-image:opensandbox-agent-lite-prod",
		"arn:aws:lambda:us-east-1:739940681129:microvm-image:opensandbox-agent-lite-dev-oc",
		"arn:aws:lambda:us-east-1:739940681129:microvm-image:blue-hello-agent-9ca56c1aef6b",
		"",
		"osb-tpl", // prefix-like but not the prefix
	} {
		if isOurTemplateImage(foreign) {
			t.Errorf("would have deleted a foreign image: %q", foreign)
		}
	}
}

// The image name goes into an AWS resource name; anything outside [A-Za-z0-9-]
// must not survive, or a build fails on a name the customer never chose.
func TestImageNameIsSanitised(t *testing.T) {
	name := templateImageName("org/../../etc passwd", "aa:bb$cc*dd")
	for _, bad := range []string{"/", " ", ":", "$", "*", ".."} {
		if strings.Contains(name, bad) {
			t.Errorf("image name %q still contains %q", name, bad)
		}
	}
	if !strings.HasPrefix(name, templateImagePrefix) {
		t.Errorf("sanitising lost the ownership prefix: %q", name)
	}
}

func TestQuotaRefusesAtTheCapWithAnActionableMessage(t *testing.T) {
	if err := checkTemplateQuota(maxImageTemplatesPerOrg - 1); err != nil {
		t.Fatalf("under the cap should be allowed: %v", err)
	}
	err := checkTemplateQuota(maxImageTemplatesPerOrg)
	if err == nil {
		t.Fatal("at the cap must be refused")
	}
	if !errors.Is(err, ErrTemplateQuotaExceeded) {
		t.Errorf("caller cannot detect the quota case: %v", err)
	}
	// A bare "quota exceeded" leaves the customer unable to act.
	for _, want := range []string{"delete an unused template"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("message is not actionable, missing %q: %v", want, err)
		}
	}
}
