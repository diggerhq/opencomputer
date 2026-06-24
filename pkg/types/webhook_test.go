package types

import "testing"

func TestValidWebhookEventFilter(t *testing.T) {
	valid := []string{
		"sandbox.created", "sandbox.stopped", "sandbox.hibernated", "sandbox.resumed",
		"sandbox.migrated", "sandbox.ready", "sandbox.checkpoint.created",
		"sandbox.forked", "sandbox.scaled", "sandbox.preview_url.changed",
		"sandbox.*",            // matches the whole namespace
		"sandbox.checkpoint.*", // matches checkpoint.created
	}
	for _, s := range valid {
		if !ValidWebhookEventFilter(s) {
			t.Errorf("expected VALID: %q", s)
		}
	}
	invalid := []string{
		"", "sandbox.stoped", "sandbox.create", "stopped", "sandbox.test",
		"sandbox.bogus.*", "other.*", "sandbox", "*",
	}
	for _, s := range invalid {
		if ValidWebhookEventFilter(s) {
			t.Errorf("expected INVALID: %q", s)
		}
	}
}
