// microvmreap terminates a specific, explicitly-listed set of MicroVMs.
//
// It exists because a drain that fires every TerminateMicrovm at once against a
// 10/s quota gets most of them throttled, and a throttled terminate used to be
// logged and dropped — stranding the box for the full 8h service cap while it
// kept billing and kept holding the regional memory quota that caps pool depth.
// On 2026-08-18 a single 255-box drain stranded 114 boxes that way.
//
// Deliberately NOT a discovery tool. It reads ids from a file and can act on
// nothing else. This account is shared, so a reaper that decided for itself
// what looked abandoned could terminate another environment's fleet, and a
// terminate is irreversible. Building the id list is a human's job — the safest
// source being ids the control plane already logged a failed terminate for,
// which are provably ours because we tried to kill them ourselves.
//
// Reports by default; --confirm is required to terminate.
//
//	microvmreap --ids /tmp/leaked.txt --region us-east-1
//	microvmreap --ids /tmp/leaked.txt --region us-east-1 --confirm
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	awscfg "github.com/aws/aws-sdk-go-v2/config"

	"github.com/opensandbox/opensandbox/internal/awsvm"
)

// terminateInterval paces terminate calls under the 10/s quota, leaving room
// for the control plane's own destroys — the whole point is to not recreate the
// throttling storm that caused the leak.
const terminateInterval = 125 * time.Millisecond

func main() {
	idsPath := flag.String("ids", "", "file of MicroVM ids, one per line (required)")
	region := flag.String("region", "", "AWS region (default: AWS_REGION)")
	confirm := flag.Bool("confirm", false, "actually terminate; without it, report only")
	flag.Parse()

	if *idsPath == "" {
		fmt.Fprintln(os.Stderr, "--ids is required")
		os.Exit(2)
	}
	ids, err := readIDs(*idsPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read ids: %v\n", err)
		os.Exit(1)
	}
	if len(ids) == 0 {
		fmt.Fprintln(os.Stderr, "id list is empty — nothing to do")
		os.Exit(1)
	}

	ctx := context.Background()
	opts := []func(*awscfg.LoadOptions) error{}
	if *region != "" {
		opts = append(opts, awscfg.WithRegion(*region))
	}
	acfg, err := awscfg.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		fmt.Fprintf(os.Stderr, "aws config: %v\n", err)
		os.Exit(1)
	}
	client := awsvm.NewClient(acfg, awsvm.Config{Region: acfg.Region})

	fmt.Printf("microvmreap: %d id(s) from %s, region=%s, confirm=%v\n\n", len(ids), *idsPath, acfg.Region, *confirm)

	// Pass 1 — establish what is actually still out there. A box that already
	// aged out costs nothing and must not be counted as reclaimed.
	var alive []string
	var gone, unknown int
	for _, id := range ids {
		box, err := client.Get(ctx, id)
		switch {
		case err != nil:
			unknown++
			fmt.Printf("  %s  UNREADABLE (%v)\n", id, err)
		case !box.Alive():
			gone++
		default:
			alive = append(alive, id)
			fmt.Printf("  %s  %s  started=%s  age=%s\n",
				id, box.State, box.StartedAt.Format(time.RFC3339), time.Since(box.StartedAt).Round(time.Minute))
		}
	}

	fmt.Printf("\nalive=%d already-gone=%d unreadable=%d\n", len(alive), gone, unknown)
	if len(alive) == 0 {
		fmt.Println("nothing to reclaim.")
		return
	}
	if !*confirm {
		fmt.Printf("\nREPORT ONLY — re-run with --confirm to terminate these %d box(es).\n", len(alive))
		return
	}

	// Pass 2 — terminate, paced, with retries. Client.Terminate classifies
	// throttling, so a throttled call is retried rather than dropped.
	fmt.Printf("\nterminating %d box(es) at %v intervals...\n", len(alive), terminateInterval)
	var ok, failed int
	for i, id := range alive {
		if i > 0 {
			time.Sleep(terminateInterval)
		}
		if err := terminateWithRetry(ctx, client, id); err != nil {
			failed++
			fmt.Printf("  FAIL %s: %v\n", id, err)
			continue
		}
		ok++
	}
	fmt.Printf("\nreclaimed %d, failed %d, of %d alive\n", ok, failed, len(alive))
	if failed > 0 {
		os.Exit(1)
	}
}

func terminateWithRetry(ctx context.Context, c *awsvm.Client, id string) error {
	backoff := 250 * time.Millisecond
	var err error
	for attempt := 1; attempt <= 6; attempt++ {
		if err = c.Terminate(ctx, id); err == nil {
			return nil
		}
		if !isThrottle(err) {
			return err
		}
		time.Sleep(backoff)
		backoff *= 2
	}
	return err
}

func isThrottle(err error) bool {
	return err != nil && strings.Contains(err.Error(), "Throttl")
}

func readIDs(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	seen := map[string]bool{}
	var ids []string
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		// Only accept the id shape, so a stray log line in the file can never
		// be interpreted as something to terminate.
		if !strings.HasPrefix(line, "microvm-") || seen[line] {
			continue
		}
		seen[line] = true
		ids = append(ids, line)
	}
	return ids, s.Err()
}
