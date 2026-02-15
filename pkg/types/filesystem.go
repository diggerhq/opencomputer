package types

// EntryInfo represents a file or directory entry.
type EntryInfo struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size,omitempty"`
	Path  string `json:"path"`
}

// FileInfo provides detailed information about a file.
type FileInfo struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	Mode    string `json:"mode"`
	ModTime string `json:"modTime"`
	Path    string `json:"path"`
}

// WatchEvent is sent over WebSocket when a file system change occurs.
type WatchEvent struct {
	Type string `json:"type"` // "create", "modify", "delete"
	Path string `json:"path"`
	Name string `json:"name"`
}
