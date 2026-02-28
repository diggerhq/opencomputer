package template

import (
	"fmt"
	"sync"
	"time"

	"github.com/opencomputer/opencomputer/pkg/types"
)

// Registry stores template metadata in-memory.
type Registry struct {
	mu        sync.RWMutex
	templates map[string]*types.Template // keyed by name
}

// NewRegistry creates a new template registry with default templates.
func NewRegistry() *Registry {
	r := &Registry{
		templates: make(map[string]*types.Template),
	}

	// Register default templates
	defaults := []struct {
		name    string
		imageID string
	}{
		{"base", "docker.io/library/ubuntu:22.04"},
		{"python", "docker.io/library/python:3.12-slim"},
		{"node", "docker.io/library/node:20-slim"},
	}

	now := time.Now()
	for _, d := range defaults {
		r.templates[d.name] = &types.Template{
			ID:        d.name,
			Name:      d.name,
			Tag:       "latest",
			ImageID:   d.imageID,
			Status:    "ready",
			CreatedAt: now,
		}
	}

	return r
}

// Get returns a template by name.
func (r *Registry) Get(name string) (*types.Template, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	t, ok := r.templates[name]
	if !ok {
		return nil, fmt.Errorf("template %q not found", name)
	}
	return t, nil
}

// List returns all templates.
func (r *Registry) List() []types.Template {
	r.mu.RLock()
	defer r.mu.RUnlock()

	result := make([]types.Template, 0, len(r.templates))
	for _, t := range r.templates {
		result = append(result, *t)
	}
	return result
}

// Register adds or updates a template.
func (r *Registry) Register(t *types.Template) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.templates[t.Name] = t
}

// Delete removes a template by name. Returns error if it's a default template.
func (r *Registry) Delete(name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, ok := r.templates[name]; !ok {
		return fmt.Errorf("template %q not found", name)
	}
	delete(r.templates, name)
	return nil
}
