package worker

import (
	"bufio"
	"os"
	"runtime"
	"strconv"
	"strings"
)

// SystemStats returns current CPU and memory usage percentages.
// On Linux, reads from /proc. On other platforms, returns 0.0 gracefully.
func SystemStats() (cpuPct, memPct float64) {
	if runtime.GOOS == "linux" {
		memPct = linuxMemoryPercent()
		cpuPct = linuxCPUPercent()
	}
	return cpuPct, memPct
}

func linuxMemoryPercent() float64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0.0
	}
	defer f.Close()

	var memTotal, memAvailable uint64
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "MemTotal:") {
			memTotal = parseMeminfoKB(line)
		} else if strings.HasPrefix(line, "MemAvailable:") {
			memAvailable = parseMeminfoKB(line)
		}
		if memTotal > 0 && memAvailable > 0 {
			break
		}
	}
	if memTotal == 0 {
		return 0.0
	}
	return float64(memTotal-memAvailable) / float64(memTotal) * 100.0
}

func parseMeminfoKB(line string) uint64 {
	// Format: "MemTotal:       16384000 kB"
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0
	}
	val, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return val
}

func linuxCPUPercent() float64 {
	// Read /proc/stat for aggregate CPU time
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0.0
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	if !scanner.Scan() {
		return 0.0
	}
	line := scanner.Text() // "cpu  user nice system idle iowait irq softirq steal"
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0.0
	}

	var total, idle uint64
	for i := 1; i < len(fields); i++ {
		val, _ := strconv.ParseUint(fields[i], 10, 64)
		total += val
		if i == 4 { // idle is the 4th value (index 4 after "cpu")
			idle = val
		}
	}
	if total == 0 {
		return 0.0
	}
	return float64(total-idle) / float64(total) * 100.0
}
