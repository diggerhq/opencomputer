package qemu

import "testing"

// The whole dual-mode rollout leans on "absent ⇒ split": any resource whose
// DiskLayout was never stamped (every box/checkpoint created before the merge)
// must be treated as the legacy two-disk layout. These tests pin that.
func TestEffectiveDiskLayout(t *testing.T) {
	cases := []struct {
		in   string
		want DiskLayout
	}{
		{"", LayoutSplit},        // untagged (pre-merge) ⇒ split
		{"split", LayoutSplit},   // explicit split
		{"merged", LayoutMerged}, // explicit merged
		{"garbage", LayoutSplit}, // unknown value ⇒ split (fail safe)
		{"MERGED", LayoutSplit},  // case-sensitive: not the merged constant
	}
	for _, c := range cases {
		if got := EffectiveDiskLayout(c.in); got != c.want {
			t.Errorf("EffectiveDiskLayout(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestIsMerged(t *testing.T) {
	if IsMerged("") {
		t.Error("IsMerged(\"\") = true, want false (absent ⇒ split)")
	}
	if IsMerged("split") {
		t.Error(`IsMerged("split") = true, want false`)
	}
	if !IsMerged("merged") {
		t.Error(`IsMerged("merged") = false, want true`)
	}
}

func TestBoolToLayout(t *testing.T) {
	if boolToLayout(true) != LayoutMerged {
		t.Errorf("boolToLayout(true) = %q, want %q", boolToLayout(true), LayoutMerged)
	}
	if boolToLayout(false) != LayoutSplit {
		t.Errorf("boolToLayout(false) = %q, want %q", boolToLayout(false), LayoutSplit)
	}
}
