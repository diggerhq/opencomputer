package commands

import (
	"fmt"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/spf13/cobra"
)

var sandboxScaleCmd = &cobra.Command{
	Use:   "scale <sandbox-id> [<memory-mb>]",
	Short: "Manually resize a sandbox (memory and/or disk)",
	Long: `Manually resize a sandbox. Any subset of memory and disk may be supplied;
unspecified dimensions are left alone. Combining them in one call applies both
changes atomically and records a single billing event.

Memory tiers (positional arg or --memory-mb): 1024, 4096, 8192, 16384, 32768,
65536 MB. CPU scales proportionally (e.g. 8 GB → 2 vCPU, 16 GB → 4 vCPU).

Disk (--disk-mb): 20480–262144 MB. Grow completes in ~1–2s online. Shrink is
refused when the guest fs used bytes leave <500 MB safety margin.

A manual memory scale disables autoscale on this sandbox; re-enable with
'oc sandbox autoscale --on' if you want it back. Disk-only scale leaves
autoscale alone.

Errors:
  scaling_locked      Sandbox has a scaling lock — unlock first.
  sandbox_hibernated  Sandbox is hibernated — wake first.
  oom_floor           Memory shrink would OOM-kill the guest.
  shrink_refused      Disk shrink would leave <500 MB safety margin.
  402 Payment...      Requested size exceeds your plan cap.`,
	Args: cobra.RangeArgs(1, 2),
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())

		memoryMB, _ := cmd.Flags().GetInt("memory-mb")
		diskMB, _ := cmd.Flags().GetInt("disk-mb")

		// Backwards-compat: positional memory-mb overrides --memory-mb.
		if len(args) == 2 {
			if _, err := fmt.Sscanf(args[1], "%d", &memoryMB); err != nil || memoryMB <= 0 {
				return fmt.Errorf("invalid memory-mb: %s", args[1])
			}
		}
		if memoryMB <= 0 && diskMB <= 0 {
			return fmt.Errorf("at least one of <memory-mb>, --memory-mb, or --disk-mb must be provided")
		}

		body := map[string]int{}
		if memoryMB > 0 {
			body["memoryMB"] = memoryMB
		}
		if diskMB > 0 {
			body["diskMB"] = diskMB
		}

		var resp struct {
			SandboxID  string `json:"sandboxID"`
			MemoryMB   int    `json:"memoryMB"`
			CPUPercent int    `json:"cpuPercent"`
			DiskMB     int    `json:"diskMB"`
		}
		if err := c.Post(cmd.Context(), "/sandboxes/"+args[0]+"/scale", body, &resp); err != nil {
			return err
		}

		printer.Print(resp, func() {
			parts := []string{}
			if resp.MemoryMB > 0 {
				parts = append(parts, fmt.Sprintf("%dMB / %d%% CPU", resp.MemoryMB, resp.CPUPercent))
			}
			if resp.DiskMB > 0 {
				parts = append(parts, fmt.Sprintf("disk %dMB", resp.DiskMB))
			}
			out := "no dimensions"
			if len(parts) > 0 {
				out = parts[0]
				for _, p := range parts[1:] {
					out += ", " + p
				}
			}
			fmt.Printf("Scaled %s to %s\n", resp.SandboxID, out)
		})
		return nil
	},
}

var sandboxAutoscaleCmd = &cobra.Command{
	Use:   "autoscale <sandbox-id>",
	Short: "Configure or inspect per-sandbox autoscale",
	Long: `Configure or inspect per-sandbox autoscale.

Run with no flags to print the current configuration.
Use --on with --min/--max to enable; --off to disable.

When enabled, the platform resizes the sandbox between min and max based
on observed memory pressure: scale up fast on a 1-min spike (>75%), scale
down only after sustained idle (1m + 5m + 15m all below 25%, 5-min
cooldown).

Errors:
  scaling_locked    Sandbox has a scaling lock — unlock first to enable.
  402 Payment...    --max exceeds your plan cap.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())
		on, _ := cmd.Flags().GetBool("on")
		off, _ := cmd.Flags().GetBool("off")
		minMB, _ := cmd.Flags().GetInt("min")
		maxMB, _ := cmd.Flags().GetInt("max")

		// No flags → status
		if !on && !off && minMB == 0 && maxMB == 0 {
			var status struct {
				SandboxID   string `json:"sandboxID"`
				Enabled     bool   `json:"enabled"`
				MinMemoryMB int    `json:"minMemoryMB"`
				MaxMemoryMB int    `json:"maxMemoryMB"`
			}
			if err := c.Get(cmd.Context(), "/sandboxes/"+args[0]+"/autoscale", &status); err != nil {
				return err
			}
			printer.Print(status, func() {
				if status.Enabled {
					fmt.Printf("Autoscale enabled for %s (%d–%d MB)\n", status.SandboxID, status.MinMemoryMB, status.MaxMemoryMB)
				} else {
					fmt.Printf("Autoscale disabled for %s\n", status.SandboxID)
				}
			})
			return nil
		}

		if on && off {
			return fmt.Errorf("--on and --off are mutually exclusive")
		}

		body := map[string]interface{}{"enabled": on}
		if on {
			if minMB == 0 || maxMB == 0 {
				return fmt.Errorf("--on requires both --min and --max")
			}
			body["minMemoryMB"] = minMB
			body["maxMemoryMB"] = maxMB
		}

		var resp struct {
			SandboxID   string `json:"sandboxID"`
			Enabled     bool   `json:"enabled"`
			MinMemoryMB int    `json:"minMemoryMB"`
			MaxMemoryMB int    `json:"maxMemoryMB"`
		}
		if err := c.PutJSON(cmd.Context(), "/sandboxes/"+args[0]+"/autoscale", body, &resp); err != nil {
			return err
		}
		printer.Print(resp, func() {
			if resp.Enabled {
				fmt.Printf("Autoscale enabled for %s (%d–%d MB)\n", resp.SandboxID, resp.MinMemoryMB, resp.MaxMemoryMB)
			} else {
				fmt.Printf("Autoscale disabled for %s\n", resp.SandboxID)
			}
		})
		return nil
	},
}

var sandboxLockCmd = &cobra.Command{
	Use:   "lock <sandbox-id>",
	Short: "Pin a sandbox at its current size (block scaling)",
	Long: `Lock the sandbox against any size change. While locked, both 'scale'
and 'autoscale --on' are rejected with a scaling_locked error, and the
platform autoscaler skips the sandbox entirely.

Locking ALSO disables autoscale (single-knob: "I don't want this scaling,
period"). Unlocking does NOT re-enable autoscale; run 'autoscale --on'
explicitly if you want it back.`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return setScalingLock(cmd, args[0], true)
	},
}

var sandboxUnlockCmd = &cobra.Command{
	Use:   "unlock <sandbox-id>",
	Short: "Allow scaling on a sandbox again (clear the lock)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		return setScalingLock(cmd, args[0], false)
	},
}

var sandboxLockStatusCmd = &cobra.Command{
	Use:   "lock-status <sandbox-id>",
	Short: "Show the scaling-lock state of a sandbox",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		c := client.FromContext(cmd.Context())
		var resp struct {
			SandboxID string `json:"sandboxID"`
			Locked    bool   `json:"locked"`
		}
		if err := c.Get(cmd.Context(), "/sandboxes/"+args[0]+"/scaling-lock", &resp); err != nil {
			return err
		}
		printer.Print(resp, func() {
			if resp.Locked {
				fmt.Printf("Sandbox %s is LOCKED (no scaling)\n", resp.SandboxID)
			} else {
				fmt.Printf("Sandbox %s is unlocked\n", resp.SandboxID)
			}
		})
		return nil
	},
}

func setScalingLock(cmd *cobra.Command, sandboxID string, locked bool) error {
	c := client.FromContext(cmd.Context())
	var resp struct {
		SandboxID string `json:"sandboxID"`
		Locked    bool   `json:"locked"`
	}
	body := map[string]bool{"locked": locked}
	if err := c.PutJSON(cmd.Context(), "/sandboxes/"+sandboxID+"/scaling-lock", body, &resp); err != nil {
		return err
	}
	printer.Print(resp, func() {
		if resp.Locked {
			fmt.Printf("Sandbox %s locked (scaling disabled)\n", resp.SandboxID)
		} else {
			fmt.Printf("Sandbox %s unlocked\n", resp.SandboxID)
		}
	})
	return nil
}

func init() {
	sandboxScaleCmd.Flags().Int("memory-mb", 0, "Target memory in MB (allowed: 1024, 4096, 8192, 16384, 32768, 65536)")
	sandboxScaleCmd.Flags().Int("disk-mb", 0, "Target workspace disk in MB (20480–262144)")

	sandboxAutoscaleCmd.Flags().Bool("on", false, "Enable autoscale (requires --min and --max)")
	sandboxAutoscaleCmd.Flags().Bool("off", false, "Disable autoscale")
	sandboxAutoscaleCmd.Flags().Int("min", 0, "Minimum memory tier in MB (allowed: 1024, 4096, 8192, 16384)")
	sandboxAutoscaleCmd.Flags().Int("max", 0, "Maximum memory tier in MB (allowed: 1024, 4096, 8192, 16384)")

	sandboxCmd.AddCommand(sandboxScaleCmd)
	sandboxCmd.AddCommand(sandboxAutoscaleCmd)
	sandboxCmd.AddCommand(sandboxLockCmd)
	sandboxCmd.AddCommand(sandboxUnlockCmd)
	sandboxCmd.AddCommand(sandboxLockStatusCmd)
}
