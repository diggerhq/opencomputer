package template

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/opensandbox/opensandbox/internal/podman"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// Builder builds container images from Dockerfiles.
type Builder struct {
	podman   *podman.Client
	registry *Registry
}

// NewBuilder creates a new template builder.
func NewBuilder(client *podman.Client, registry *Registry) *Builder {
	return &Builder{
		podman:   client,
		registry: registry,
	}
}

// Build builds a template from Dockerfile content.
func (b *Builder) Build(ctx context.Context, dockerfileContent, name string) (*types.Template, error) {
	buildID := uuid.New().String()[:8]
	tag := "latest"
	imageName := fmt.Sprintf("localhost/opensandbox-template/%s:%s", name, tag)

	// Write Dockerfile to temp directory
	tmpDir, err := os.MkdirTemp("", "opensandbox-build-*")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp dir for build: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	dockerfilePath := filepath.Join(tmpDir, "Dockerfile")
	if err := os.WriteFile(dockerfilePath, []byte(dockerfileContent), 0644); err != nil {
		return nil, fmt.Errorf("failed to write Dockerfile: %w", err)
	}

	// Build image with podman
	result, err := b.podman.Run(ctx, "build", "-t", imageName, "-f", dockerfilePath, tmpDir)
	if err != nil {
		return nil, fmt.Errorf("failed to build template %s: %w", name, err)
	}
	if result.ExitCode != 0 {
		return nil, fmt.Errorf("podman build failed (exit %d): %s", result.ExitCode, result.Stderr)
	}

	tmpl := &types.Template{
		ID:        name,
		Name:      name,
		Tag:       tag,
		ImageID:   imageName,
		BuildID:   buildID,
		Status:    "ready",
		CreatedAt: time.Now(),
	}

	b.registry.Register(tmpl)
	return tmpl, nil
}
