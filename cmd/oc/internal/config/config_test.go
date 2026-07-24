package config

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func useTemporaryHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	if runtime.GOOS == "windows" {
		t.Setenv("USERPROFILE", home)
	}
	return home
}

func TestSaveIsPrivateAndRoundTripsLoginMetadata(t *testing.T) {
	home := useTemporaryHome(t)
	want := Config{
		APIURL: "https://example.test",
		APIKey: "osb_secret",
		Login: &LoginMetadata{
			CredentialID: "key-1",
			KeyPrefix:    "osb_abcd",
			Name:         "oc CLI on test",
			APIURL:       "https://example.test",
		},
	}
	if err := Save(want); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got := LoadFile()
	if got.APIKey != want.APIKey || got.Login == nil || got.Login.CredentialID != "key-1" {
		t.Fatalf("LoadFile() = %#v, want %#v", got, want)
	}

	if runtime.GOOS != "windows" {
		dirInfo, err := os.Stat(filepath.Join(home, ".oc"))
		if err != nil {
			t.Fatal(err)
		}
		if got := dirInfo.Mode().Perm(); got != 0o700 {
			t.Fatalf("config dir mode = %o, want 700", got)
		}
		fileInfo, err := os.Stat(ConfigPath())
		if err != nil {
			t.Fatal(err)
		}
		if got := fileInfo.Mode().Perm(); got != 0o600 {
			t.Fatalf("config mode = %o, want 600", got)
		}
	}

	matches, err := filepath.Glob(filepath.Join(home, ".oc", ".config-*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("temporary config files left behind: %v", matches)
	}
}

func TestEffectiveCredentialSourcePrecedence(t *testing.T) {
	useTemporaryHome(t)
	if got := EffectiveCredentialSource(nil); got != CredentialSourceNone {
		t.Fatalf("empty source = %q", got)
	}
	if err := Save(Config{APIKey: "file"}); err != nil {
		t.Fatal(err)
	}
	if got := EffectiveCredentialSource(nil); got != CredentialSourceFile {
		t.Fatalf("file source = %q", got)
	}
	t.Setenv("OPENCOMPUTER_API_KEY", "environment")
	if got := EffectiveCredentialSource(nil); got != CredentialSourceEnvironment {
		t.Fatalf("env source = %q", got)
	}
}
