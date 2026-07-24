//go:build linux

package agent

import (
	"fmt"
	"syscall"
)

// fithawIoctl is FITHAW = _IOWR('X', 120, int) — unfreeze a filesystem.
// (FIFREEZE is 0xc0045877.) We hardcode it because the syscall package does not
// export it, mirroring flushBlockDevices' use of a literal BLKFLSBUF constant.
const fithawIoctl = 0xc0045878

// thawMount unfreezes the filesystem containing mountpoint via the FITHAW ioctl.
//
// This is deliberately native — no exec. The golden/hibernate snapshot is
// captured with the rootfs fsfrozen, and thawing it by exec'ing a binary that
// lives on that frozen rootfs can deadlock (exec faults/atime take
// sb_start_write(), which blocks until thaw — which needs the exec). Opening the
// mountpoint O_RDONLY|O_NOATIME and issuing FITHAW never writes to the fs:
//   - O_NOATIME suppresses the access-time update that a normal open/exec would
//     perform (the operation that takes sb_start_write() and blocks on a frozen fs);
//   - a read-only directory open and the FITHAW ioctl itself modify nothing.
// So this is safe to call against a still-frozen filesystem, which is the whole
// point. The agent runs as root, so O_NOATIME is permitted.
//
// Returns alreadyThawed=true when the fs was not frozen (FITHAW → EINVAL), which
// we treat as success so the call is idempotent across wake/fork/golden-restore.
func thawMount(mountpoint string) (alreadyThawed bool, err error) {
	fd, err := syscall.Open(mountpoint, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOATIME|syscall.O_CLOEXEC, 0)
	if err != nil {
		return false, fmt.Errorf("open %s: %w", mountpoint, err)
	}
	defer syscall.Close(fd)

	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), uintptr(fithawIoctl), 0); errno != 0 {
		if errno == syscall.EINVAL {
			return true, nil // not frozen — already thawed
		}
		return false, fmt.Errorf("FITHAW %s: %w", mountpoint, errno)
	}
	return false, nil
}
