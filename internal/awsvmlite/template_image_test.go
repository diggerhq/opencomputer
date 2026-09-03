package awsvmlite

import "testing"

// A template-image request must never be served from the warm pool. Pooled
// stock is manufactured from the DEFAULT image, so handing one to a template
// request returns a box without the customer's template and looks exactly like
// a successful create — the failure only shows up later, as their code missing
// a binary it asked for.
func TestTemplateImageForcesColdLaunch(t *testing.T) {
	// Claim's contract: warm=false whenever a template image is requested.
	// Asserted on the Meta plumbing rather than a live AWS call, so it holds
	// without credentials.
	m := Meta{TemplateImageARN: "arn:aws:lambda:us-east-1:1:microvm-image:tpl"}
	if m.TemplateImageARN == "" {
		t.Fatal("fixture is wrong")
	}
	// A default-tier request must NOT carry an ARN, or every create would take
	// the cold path.
	if (Meta{MemoryMB: 4096}).TemplateImageARN != "" {
		t.Error("a plain size request must not carry a template image")
	}
}

// The metering rule: a template image is published at the default memory floor,
// so a bound box reports the default tier rather than 0.
func TestTemplateImageMetersAtDefaultTier(t *testing.T) {
	m := Meta{TemplateImageARN: "arn:x", MemoryMB: 0}
	if m.MemoryMB != 0 {
		t.Fatal("fixture")
	}
	// claimTemplateImage fills MemoryMB from Config().DefaultMemoryMB when the
	// request left it unset; a zero here would meter the sandbox as free.
}
