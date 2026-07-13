//go:build linux

package qemu

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

// iovec mirrors C `struct iovec` for process_madvise. base holds an address in
// the TARGET process's address space — it is never dereferenced here, so it's a
// plain uintptr (avoids the unsafe.Pointer(uintptr) foreign-address pattern that
// go vet flags). On 64-bit both fields are 8 bytes, matching the kernel ABI.
type iovec struct {
	base   uintptr
	length uintptr
}

// reclaimGuestRAM proactively pages a (stopped) VM's guest memory out to the
// host swap tier (zram + disk fallback) so a paused VM's physical footprint
// drops to its compressed/needed set — without touching the guest, without
// file-backed memory, and without savevm (so it never hits the qcow2/ext4
// corruption surface). It process_madvise(MADV_PAGEOUT)s the large anonymous
// rw-p mappings in /proc/<pid>/maps (guest RAM); QEMU's own heap/stacks are far
// below minRegionBytes and stay resident.
//
// Preconditions: the vCPUs are already QMP-stopped (so nothing immediately
// re-faults the pages) and the caller has CAP_SYS_NICE + ptrace access to pid
// (the worker runs as root). Best-effort — returns the bytes advised.
func reclaimGuestRAM(pid int, minRegionBytes uint64) (uint64, error) {
	iovs, total, err := guestRAMRegions(pid, minRegionBytes)
	if err != nil {
		return 0, err
	}
	if len(iovs) == 0 {
		return 0, nil
	}

	pidfd, _, errno := syscall.Syscall(unix.SYS_PIDFD_OPEN, uintptr(pid), 0, 0)
	if errno != 0 {
		return 0, fmt.Errorf("pidfd_open(%d): %w", pid, errno)
	}
	defer syscall.Close(int(pidfd))

	// process_madvise may advise fewer bytes than requested per call; resume
	// from where it stopped so every region is covered.
	off := 0
	for off < len(iovs) {
		n, _, errno := syscall.Syscall6(unix.SYS_PROCESS_MADVISE,
			pidfd,
			uintptr(unsafe.Pointer(&iovs[off])),
			uintptr(len(iovs)-off),
			uintptr(unix.MADV_PAGEOUT),
			0, 0)
		if errno != 0 {
			return total, fmt.Errorf("process_madvise: %w", errno)
		}
		if n == 0 {
			break // nothing advanced — avoid an infinite loop
		}
		// Advance past fully-advised iovecs; shrink a partially-advised one.
		adv := uintptr(n)
		for off < len(iovs) && adv >= iovs[off].length {
			adv -= iovs[off].length
			off++
		}
		if adv > 0 && off < len(iovs) {
			iovs[off].base += adv
			iovs[off].length -= adv
		}
	}
	return total, nil
}

// guestRAMRegions parses /proc/<pid>/maps and returns iovecs for the large
// anonymous rw-p mappings (guest RAM) plus their total size. File-backed guest
// memory is intentionally out of scope (we don't use memory-backend-file).
func guestRAMRegions(pid int, minRegionBytes uint64) ([]iovec, uint64, error) {
	f, err := os.Open(fmt.Sprintf("/proc/%d/maps", pid))
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()

	var iovs []iovec
	var total uint64
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 256*1024), 1024*1024)
	for sc.Scan() {
		// format: start-end perms offset dev inode [pathname]
		fields := strings.Fields(sc.Text())
		if len(fields) < 5 {
			continue
		}
		perms := fields[1]
		// Guest RAM is private, readable, writable. Skip shared/exec/read-only.
		if len(perms) < 4 || perms[0] != 'r' || perms[1] != 'w' || perms[3] != 'p' {
			continue
		}
		// Anonymous only: no pathname, or a kernel-synthesised [anon:...] name.
		// A real file path means file-backed memory — not us.
		if len(fields) >= 6 && fields[5] != "" && !strings.HasPrefix(fields[5], "[anon") {
			continue
		}
		dash := strings.IndexByte(fields[0], '-')
		if dash < 0 {
			continue
		}
		start, err1 := strconv.ParseUint(fields[0][:dash], 16, 64)
		end, err2 := strconv.ParseUint(fields[0][dash+1:], 16, 64)
		if err1 != nil || err2 != nil || end <= start {
			continue
		}
		if sz := end - start; sz >= minRegionBytes {
			iovs = append(iovs, iovec{base: uintptr(start), length: uintptr(sz)})
			total += sz
		}
	}
	return iovs, total, sc.Err()
}
