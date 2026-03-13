package firecracker

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const cgroupBase = "/sys/fs/cgroup"

// cgroupName returns the cgroup name for a sandbox.
func cgroupName(sandboxID string) string {
	return "opensandbox-" + sandboxID
}

// cgroupPath returns the full path to a sandbox's cgroup directory.
func cgroupPath(sandboxID string) string {
	return filepath.Join(cgroupBase, cgroupName(sandboxID))
}

// CreateCgroup creates a cgroup v2 for a sandbox and moves the given PID into it.
// Sets an initial memory.max limit.
func CreateCgroup(sandboxID string, pid int, memoryLimitBytes int64) error {
	dir := cgroupPath(sandboxID)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create cgroup dir: %w", err)
	}

	// Set memory limit
	if err := os.WriteFile(filepath.Join(dir, "memory.max"), []byte(strconv.FormatInt(memoryLimitBytes, 10)), 0644); err != nil {
		os.Remove(dir)
		return fmt.Errorf("set memory.max: %w", err)
	}

	// Disable swap to prevent swapping (keep behavior predictable)
	_ = os.WriteFile(filepath.Join(dir, "memory.swap.max"), []byte("0"), 0644)

	// Move the Firecracker process into the cgroup
	if err := os.WriteFile(filepath.Join(dir, "cgroup.procs"), []byte(strconv.Itoa(pid)), 0644); err != nil {
		os.RemoveAll(dir)
		return fmt.Errorf("move pid to cgroup: %w", err)
	}

	return nil
}

// UpdateCgroupMemoryLimit updates the memory.max for a running sandbox's cgroup.
func UpdateCgroupMemoryLimit(sandboxID string, memoryLimitBytes int64) error {
	path := filepath.Join(cgroupPath(sandboxID), "memory.max")
	return os.WriteFile(path, []byte(strconv.FormatInt(memoryLimitBytes, 10)), 0644)
}

// ReadCgroupMemoryCurrent reads the current memory usage (in bytes) from the cgroup.
func ReadCgroupMemoryCurrent(sandboxID string) (int64, error) {
	path := filepath.Join(cgroupPath(sandboxID), "memory.current")
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
}

// RemoveCgroup removes the cgroup for a sandbox.
// The cgroup must be empty (no processes) before removal.
func RemoveCgroup(sandboxID string) error {
	dir := cgroupPath(sandboxID)
	// rmdir removes the cgroup directory (only works if empty)
	return os.Remove(dir)
}
