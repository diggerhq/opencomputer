// mvmwipe — list and (with -apply) terminate MicroVMs in the account/region.
//
// Uses the same client the control plane uses, so ownership and throttling
// behave identically. Dry-run by default: it prints the inventory grouped by
// image ARN and state, and terminates nothing unless -apply is passed.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/opensandbox/opensandbox/internal/awsvm"
)

func main() {
	apply := flag.Bool("apply", false, "actually terminate (default: dry run)")
	image := flag.String("image", "", "only touch boxes with this image ARN (default: all)")
	conc := flag.Int("c", 8, "terminate concurrency")
	out := flag.String("out", "", "write target IDs here and exit (one List pass, then reusable)")
	from := flag.String("from", "", "read target IDs from this file instead of calling List")
	state := flag.String("state", "RUNNING", "only touch boxes in this state (empty = all). Terminating an already-TERMINATED box is a wasted call straight into the throttler.")
	ids := flag.String("ids", "", "terminate exactly these box or sandbox IDs (comma/space separated). Skips List entirely — the targeted intervention.")
	allImages := flag.Bool("all-images", false, "permit -apply without -image. Required, because the image ARN is the only ownership test this account has.")
	flag.Parse()

	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = os.Getenv("OPENSANDBOX_MICROVM_REGION")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		fmt.Fprintln(os.Stderr, "aws config:", err)
		os.Exit(1)
	}
	c := awsvm.NewClient(awsCfg, awsvm.Config{Region: region})

	// -ids is the intervention path: something told you exactly which boxes are
	// stranded (a bench run printing its leaks, a budget log naming them) and you
	// want those gone and nothing else. No List, no filters to get wrong, no way
	// to widen the blast radius by fat-fingering a flag.
	if *ids != "" {
		targets := strings.FieldsFunc(*ids, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' || r == '\t' })
		fmt.Printf("targets: %d (explicit)\n", len(targets))
		for _, id := range targets {
			fmt.Printf("  %s\n", id)
		}
		if !*apply {
			fmt.Println("\nDRY RUN — nothing terminated. Re-run with -apply.")
			return
		}
		terminate(ctx, c, targets, *conc)
		return
	}

	// The image ARN is the only thing distinguishing our boxes from anything else
	// running in this account, so a bulk -apply without it is a wipe with no
	// ownership test at all. Making that an explicit opt-in rather than a default
	// is the difference between a tool and an accident.
	if *apply && *image == "" && !*allImages {
		fmt.Fprintln(os.Stderr, "refusing to -apply across every image: pass -image <arn> to scope it, or -all-images if you truly mean the whole account.")
		os.Exit(2)
	}

	// -from skips List entirely. List pages through every record the API has
	// ever returned (5k+ here) under heavy throttling with a 6-attempt backoff
	// ladder, so it can outlive a short-lived credential all on its own — which
	// is exactly how the first wipe attempt died before terminating anything.
	// One List, cached to a file, then terminate as many times as it takes.
	if *from != "" {
		raw, err := os.ReadFile(*from)
		if err != nil {
			fmt.Fprintln(os.Stderr, "read -from:", err)
			os.Exit(1)
		}
		var targets []string
		for _, line := range strings.Split(string(raw), "\n") {
			if id := strings.TrimSpace(line); id != "" {
				targets = append(targets, id)
			}
		}
		fmt.Printf("loaded %d target(s) from %s\n", len(targets), *from)
		if !*apply {
			fmt.Println("DRY RUN — nothing terminated. Re-run with -apply.")
			return
		}
		terminate(ctx, c, targets, *conc)
		return
	}

	boxes, err := c.List(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, "list:", err)
		os.Exit(1)
	}

	byImage := map[string]int{}
	byState := map[string]int{}
	var targets []string
	for _, b := range boxes {
		byImage[b.ImageArn]++
		byState[fmt.Sprint(b.State)]++
		if *image != "" && b.ImageArn != *image {
			continue
		}
		if *state != "" && !strings.EqualFold(fmt.Sprint(b.State), *state) {
			continue
		}
		targets = append(targets, b.ID)
	}
	fmt.Printf("total microvms: %d\n", len(boxes))
	fmt.Println("by image:")
	keys := make([]string, 0, len(byImage))
	for k := range byImage {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Printf("  %-70s %d\n", k, byImage[k])
	}
	fmt.Println("by state:")
	for k, v := range byState {
		fmt.Printf("  %-20s %d\n", k, v)
	}
	fmt.Printf("targets: %d\n", len(targets))

	if *out != "" {
		if err := os.WriteFile(*out, []byte(strings.Join(targets, "\n")+"\n"), 0o600); err != nil {
			fmt.Fprintln(os.Stderr, "write -out:", err)
			os.Exit(1)
		}
		fmt.Printf("wrote %d target(s) -> %s (re-run with -from %s -apply)\n", len(targets), *out, *out)
		return
	}

	if !*apply {
		fmt.Println("\nDRY RUN — nothing terminated. Re-run with -apply to wipe.")
		return
	}
	terminate(ctx, c, targets, *conc)
}

func terminate(ctx context.Context, c *awsvm.Client, targets []string, conc int) {

	var (
		mu       sync.Mutex
		ok, fail int
	)
	sem := make(chan struct{}, conc)
	var wg sync.WaitGroup
	for _, id := range targets {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			// Terminate is throttled like the rest of the API; retry a few times
			// so a throttled call does not leak the box's quota until the 8h cap.
			var err error
			for attempt := 0; attempt < 5; attempt++ {
				if err = c.Terminate(ctx, id); err == nil {
					break
				}
				time.Sleep(time.Duration(200*(1<<attempt)) * time.Millisecond)
			}
			mu.Lock()
			if err == nil {
				ok++
			} else {
				fail++
				if fail <= 5 {
					fmt.Fprintf(os.Stderr, "terminate %s: %v\n", id, err)
				}
			}
			n := ok + fail
			if n%25 == 0 {
				fmt.Printf("  %d/%d terminated (%d failed)\n", n, len(targets), fail)
			}
			mu.Unlock()
		}(id)
	}
	wg.Wait()
	fmt.Printf("\nterminated %d, failed %d, of %d\n", ok, fail, len(targets))
}
