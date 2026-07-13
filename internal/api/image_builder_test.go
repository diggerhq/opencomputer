package api

import (
	"bytes"
	"encoding/base64"
	"testing"
)

func TestParseAddFileStepLargeBinary(t *testing.T) {
	content := make([]byte, 8*1024*1024)
	for i := range content {
		content[i] = byte(i % 251)
	}

	filePath, got, err := parseAddFileStep(ImageStep{
		Type: "add_file",
		Args: map[string]interface{}{
			"path":     "/tmp/large.bin",
			"content":  base64.StdEncoding.EncodeToString(content),
			"encoding": "base64",
		},
	})
	if err != nil {
		t.Fatalf("parseAddFileStep returned error: %v", err)
	}
	if filePath != "/tmp/large.bin" {
		t.Fatalf("path = %q, want /tmp/large.bin", filePath)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("decoded content mismatch: got %d bytes, want %d", len(got), len(content))
	}
}

func TestParseAddFileStepBinaryRoundTrip(t *testing.T) {
	content := []byte{0x00, 0xff, 0x10, '\n', '\'', 0x80}

	_, got, err := parseAddFileStep(ImageStep{
		Type: "add_file",
		Args: map[string]interface{}{
			"path":    "/opt/app/blob.dat",
			"content": base64.StdEncoding.EncodeToString(content),
		},
	})
	if err != nil {
		t.Fatalf("parseAddFileStep returned error: %v", err)
	}
	if !bytes.Equal(got, content) {
		t.Fatalf("decoded content = %v, want %v", got, content)
	}
}

func TestParseAddFileStepRequiresAbsolutePath(t *testing.T) {
	_, _, err := parseAddFileStep(ImageStep{
		Type: "add_file",
		Args: map[string]interface{}{
			"path":    "tmp/file.txt",
			"content": base64.StdEncoding.EncodeToString([]byte("hello")),
		},
	})
	if err == nil {
		t.Fatal("parseAddFileStep succeeded with a relative path")
	}
}

func TestParseAddDirStepLargeFile(t *testing.T) {
	content := bytes.Repeat([]byte{0xab}, 8*1024*1024)

	basePath, files, err := parseAddDirStep(ImageStep{
		Type: "add_dir",
		Args: map[string]interface{}{
			"path": "/srv/app",
			"files": []interface{}{
				map[string]interface{}{
					"relativePath": "bin/large.bin",
					"content":      base64.StdEncoding.EncodeToString(content),
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("parseAddDirStep returned error: %v", err)
	}
	if basePath != "/srv/app" {
		t.Fatalf("basePath = %q, want /srv/app", basePath)
	}
	if len(files) != 1 {
		t.Fatalf("got %d files, want 1", len(files))
	}
	if files[0].path != "/srv/app/bin/large.bin" {
		t.Fatalf("path = %q, want /srv/app/bin/large.bin", files[0].path)
	}
	if !bytes.Equal(files[0].content, content) {
		t.Fatalf("decoded content mismatch: got %d bytes, want %d", len(files[0].content), len(content))
	}
}

func TestParseAddDirStepAllowsEmptyDirectory(t *testing.T) {
	basePath, files, err := parseAddDirStep(ImageStep{
		Type: "add_dir",
		Args: map[string]interface{}{
			"path":  "/srv/empty",
			"files": []interface{}{},
		},
	})
	if err != nil {
		t.Fatalf("parseAddDirStep returned error: %v", err)
	}
	if basePath != "/srv/empty" {
		t.Fatalf("basePath = %q, want /srv/empty", basePath)
	}
	if len(files) != 0 {
		t.Fatalf("got %d files, want 0", len(files))
	}
}

func TestParseAddDirStepRejectsTraversal(t *testing.T) {
	for _, relPath := range []string{"../escape", "nested/../../escape", "/absolute"} {
		t.Run(relPath, func(t *testing.T) {
			_, _, err := parseAddDirStep(ImageStep{
				Type: "add_dir",
				Args: map[string]interface{}{
					"path": "/srv/app",
					"files": []interface{}{
						map[string]interface{}{
							"relativePath": relPath,
							"content":      base64.StdEncoding.EncodeToString([]byte("hello")),
						},
					},
				},
			})
			if err == nil {
				t.Fatalf("parseAddDirStep succeeded with relativePath %q", relPath)
			}
		})
	}
}

func TestTranslateStepToCommandRejectsFileSteps(t *testing.T) {
	if _, err := translateStepToCommand(ImageStep{Type: "add_file", Args: map[string]interface{}{}}); err == nil {
		t.Fatal("translateStepToCommand accepted add_file")
	}
	if _, err := translateStepToCommand(ImageStep{Type: "add_dir", Args: map[string]interface{}{}}); err == nil {
		t.Fatal("translateStepToCommand accepted add_dir")
	}
}
