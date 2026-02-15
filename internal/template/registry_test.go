package template

import (
	"testing"

	"github.com/opensandbox/opensandbox/pkg/types"
)

func TestNewRegistry_HasDefaults(t *testing.T) {
	r := NewRegistry()
	templates := r.List()
	if len(templates) != 3 {
		t.Fatalf("expected 3 default templates, got %d", len(templates))
	}

	base, err := r.Get("base")
	if err != nil {
		t.Fatalf("Get(base) error: %v", err)
	}
	if base.ImageID != "docker.io/library/ubuntu:22.04" {
		t.Errorf("expected ubuntu image, got %s", base.ImageID)
	}
}

func TestRegistry_RegisterAndGet(t *testing.T) {
	r := NewRegistry()
	r.Register(&types.Template{
		ID:      "custom",
		Name:    "custom",
		Tag:     "v1",
		ImageID: "test-image",
		Status:  "ready",
	})

	tmpl, err := r.Get("custom")
	if err != nil {
		t.Fatalf("Get(custom) error: %v", err)
	}
	if tmpl.Tag != "v1" {
		t.Errorf("expected tag v1, got %s", tmpl.Tag)
	}
}

func TestRegistry_Delete(t *testing.T) {
	r := NewRegistry()
	if err := r.Delete("base"); err != nil {
		t.Fatalf("Delete(base) error: %v", err)
	}

	_, err := r.Get("base")
	if err == nil {
		t.Error("expected error after deleting base template")
	}
}

func TestRegistry_DeleteNotFound(t *testing.T) {
	r := NewRegistry()
	err := r.Delete("nonexistent")
	if err == nil {
		t.Error("expected error for nonexistent template")
	}
}

func TestRegistry_GetNotFound(t *testing.T) {
	r := NewRegistry()
	_, err := r.Get("nonexistent")
	if err == nil {
		t.Error("expected error for nonexistent template")
	}
}
