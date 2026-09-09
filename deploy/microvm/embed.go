// Package microvmimage exposes the MicroVM base image definition to the Go
// build, so custom templates are compiled from the SAME Dockerfile the pool
// image is built from rather than from a copy of it.
//
// The alternative — writing a prologue/epilogue in Go — was rejected: it puts
// the agent contract (which binaries land where, who PID 1 is, where the
// sandbox user comes from) in two places that must be edited together, and the
// failure mode when they drift is a custom-template box that builds fine and
// then never becomes ready.
package microvmimage

import (
	_ "embed"
	"fmt"
	"strings"
)

//go:embed Dockerfile
var dockerfile string

// customLayerMarker is the single point where custom-template layers may be
// spliced. See the comment around it in Dockerfile for why the position is
// load-bearing.
const customLayerMarker = "# ==== OSB_CUSTOM_TEMPLATE_LAYERS ===="

// Split returns the base image definition either side of the custom-layer
// marker. Customer layers go between them, and nowhere else.
//
// An error here means someone edited Dockerfile and removed the marker. That
// must fail loudly at startup rather than silently producing an image with no
// customer layers in it — which would look like a successful build of a
// template that does nothing.
func Split() (prologue, epilogue string, err error) {
	idx := strings.Index(dockerfile, customLayerMarker)
	if idx < 0 {
		return "", "", fmt.Errorf("microvmimage: %q not found in Dockerfile — custom templates cannot be compiled", customLayerMarker)
	}
	return dockerfile[:idx], dockerfile[idx:], nil
}

// Dockerfile returns the unmodified base image definition, for the pool image
// build path that has no customer layers.
func Dockerfile() string { return dockerfile }
