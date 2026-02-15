package types

import "time"

// Template represents a sandbox template (a container image).
type Template struct {
	ID        string    `json:"templateID"`
	Name      string    `json:"name"`
	Tag       string    `json:"tag,omitempty"`
	ImageID   string    `json:"imageID,omitempty"`
	BuildID   string    `json:"buildID,omitempty"`
	Status    string    `json:"status"` // "ready", "building", "error"
	CreatedAt time.Time `json:"createdAt"`
}

// TemplateBuildRequest is the request body for building a template.
type TemplateBuildRequest struct {
	Dockerfile string `json:"dockerfile"`
	Name       string `json:"name"`
	Tag        string `json:"tag,omitempty"`
}
