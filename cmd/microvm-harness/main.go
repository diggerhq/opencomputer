// Command microvm-harness measures the AWS Lambda MicroVM backend end to end:
// fill a warm pool, claim from it, exec through Lambda's auth proxy, tear down.
//
// It exists to answer two questions that no amount of documentation settles,
// and that decide whether this backend is viable:
//
//  1. Does gRPC actually survive Lambda's JWE proxy? The proxy is documented to
//     support HTTP/2, and gRPC is HTTP/2 — but "supports HTTP/2" and "forwards
//     long-lived bidirectional HTTP/2 streams with custom headers intact" are
//     different claims. If this fails, the agent transport has to change.
//
//  2. What does a claim+exec actually cost at burst width? The pool design
//     exists because RunMicrovm is 5/s and ResumeMicrovm is 5/s, so a burst
//     cannot make AWS calls at all. This measures whether the claim path really
//     is free and where the remaining latency sits.
//
// It is a measurement tool, not a service: it creates only MicroVMs from the
// image it is pointed at, and terminates everything it created before exiting.
//
//	go run ./cmd/microvm-harness -image <ARN> -stock 5 -burst 5
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	awsTypes "github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
	"github.com/gorilla/websocket"
	"github.com/opensandbox/opensandbox/internal/awsvm"
	"github.com/opensandbox/opensandbox/internal/storage"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// Ports the image declares: hooks on 8080 (the one Lambda already reaches
// during the build) and osb-agent's gRPC on 8081.
const (
	hookPort  int32 = 8080
	agentPort int32 = 8081
)

func main() {
	var (
		image     = flag.String("image", os.Getenv("MICROVM_IMAGE_ARN"), "MicroVM image ARN or name (required)")
		role      = flag.String("role", os.Getenv("MICROVM_EXECUTION_ROLE_ARN"), "execution role ARN assumed by the guest")
		region    = flag.String("region", envOr("AWS_REGION", "us-east-1"), "AWS region")
		stock     = flag.Int("stock", 5, "warm pool depth to fill before claiming")
		burst     = flag.Int("burst", 5, "how many sandboxes to claim+exec simultaneously")
		command   = flag.String("cmd", "node -v", "command to exec in each sandbox")
		fillWait  = flag.Duration("fill-timeout", 5*time.Minute, "how long to wait for the pool to fill")
		keep      = flag.Bool("keep", false, "leave MicroVMs running on exit (for manual poking)")
		lifecycle = flag.Int("lifecycle-mb", 0, "run the hibernate/wake lifecycle sim with an N-MB workspace")
		resumeB   = flag.Bool("resume-bench", false, "measure suspend/resume: how long a hibernated box takes to become usable again")
		probe     = flag.Bool("probe", false, "instead of exec, probe plain HTTP /healthz on the hook port to isolate proxy reachability from gRPC")
		// Defaults to the hook port: Lambda forwards only there, and the hook
		// server bridges to the agent. 8081 is kept reachable via this flag
		// purely to re-demonstrate that a direct agent port returns 502.
		gPort = flag.Int("agent-port", int(hookPort), "guest port to send gRPC to")
		// More than one exec per box separates cold-channel cost from steady state.
		execsPer = flag.Int("execs", 3, "execs per sandbox; the first is cold, the rest warm")
	)
	flag.Parse()

	if *image == "" {
		log.Fatal("-image is required (the MicroVM image ARN built by deploy/microvm/publish.sh)")
	}
	if *burst > *stock {
		log.Fatalf("-burst %d exceeds -stock %d: the point of the pool is that a burst never waits on AWS", *burst, *stock)
	}

	// Ctrl-C must still terminate what we launched: a leaked MicroVM burns
	// regional memory quota until it hits the 8h cap, and quota is the ceiling
	// on pool depth.
	ctx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(*region))
	if err != nil {
		log.Fatalf("load AWS config: %v", err)
	}

	client := awsvm.NewClient(awsCfg, awsvm.Config{
		Region:           *region,
		ImageIdentifier:  *image,
		ExecutionRoleArn: *role,
		AgentPort:        int32(*gPort),
		// Idle-suspend must be off for pooled stock. A box that suspends itself
		// while waiting turns the next claim into a throttled ResumeMicrovm,
		// which is the exact cost the pool exists to avoid.
		AutoResume: false,
	})

	pool := awsvm.NewPool(client, awsvm.PoolConfig{TargetStock: *stock})
	mgr := awsvm.NewManager(client, os.TempDir())
	defer mgr.Close()

	poolCtx, stopPool := context.WithCancel(ctx)
	defer stopPool()
	go pool.Run(poolCtx)

	if err := waitForStock(ctx, pool, *stock, *fillWait); err != nil {
		log.Printf("pool never filled: %v (depth=%d)", err, pool.Depth())
		if !*keep {
			pool.Drain()
		}
		os.Exit(1)
	}

	// Stop launching before measuring. Otherwise the launch ticker keeps calling
	// RunMicrovm during the burst and we would be measuring the pool topping
	// itself up, not the claim path.
	stopPool()

	if *probe {
		probeProxy(ctx, awsCfg, *region, *image, pool)
		pool.Drain()
		return
	}

	if *lifecycle > 0 {
		st, sErr := storage.NewCheckpointStore(storage.S3Config{
			Endpoint:        os.Getenv("OPENSANDBOX_S3_ENDPOINT"),
			Bucket:          os.Getenv("OPENSANDBOX_S3_BUCKET"),
			Region:          envOr("OPENSANDBOX_S3_REGION", "auto"),
			AccessKeyID:     os.Getenv("OPENSANDBOX_S3_ACCESS_KEY"),
			SecretAccessKey: os.Getenv("OPENSANDBOX_S3_SECRET_KEY"),
			ForcePathStyle:  true,
		})
		if sErr != nil {
			log.Fatalf("checkpoint store: %v", sErr)
		}
		runLifecycleSim(ctx, client, pool, mgr, st, *lifecycle)
		pool.Drain()
		return
	}

	if *resumeB {
		runResumeBench(ctx, client, pool, mgr, *burst, *command)
		pool.Drain()
		return
	}

	results := runBurst(ctx, pool, mgr, *burst, *command, *execsPer)
	report(results)

	if *keep {
		log.Printf("-keep set: leaving %d pooled + %d claimed MicroVMs running", pool.Depth(), len(results))
		return
	}
	log.Printf("cleaning up…")
	for _, r := range results {
		if r.sandboxID != "" {
			if err := mgr.Kill(context.WithoutCancel(ctx), r.sandboxID); err != nil {
				log.Printf("  terminate %s: %v", r.sandboxID, err)
			}
		}
	}
	pool.Drain()
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// waitForStock blocks until the pool reaches the target depth, reporting
// progress so a slow fill is visibly a fill and not a hang.
func waitForStock(ctx context.Context, pool *awsvm.Pool, target int, timeout time.Duration) error {
	start := time.Now()
	deadline := time.Now().Add(timeout)
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	last := -1
	for {
		if d := pool.Depth(); d >= target {
			log.Printf("pool filled: %d boxes in %s (%.1f boxes/s)",
				d, time.Since(start).Round(time.Millisecond), float64(d)/time.Since(start).Seconds())
			return nil
		} else if d != last {
			log.Printf("  filling: %d/%d", d, target)
			last = d
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
			if time.Now().After(deadline) {
				return fmt.Errorf("timed out after %s", timeout)
			}
		}
	}
}

// result is one sandbox's timings. claim and exec are separated because they
// answer different questions: claim should be ~0 by construction, while exec is
// the number that actually reaches the customer.
type result struct {
	sandboxID string
	claim     time.Duration
	// exec is the FIRST exec on a freshly claimed box, which pays the whole
	// cold-channel cost: token mint, WebSocket handshake, HTTP/2 setup.
	exec time.Duration
	// warm are subsequent execs on the same established channel. This is the
	// number that describes steady-state latency, and the two must never be
	// conflated — quoting the cold figure as "exec latency" overstates it by
	// roughly a second.
	warm   []time.Duration
	stdout string
	err    error
}

// runBurst claims and execs n sandboxes simultaneously. Simultaneously is the
// point: a staggered run hides exactly the contention a real create burst hits.
func runBurst(ctx context.Context, pool *awsvm.Pool, mgr *awsvm.Manager, n int, command string, execs int) []result {
	log.Printf("bursting %d claim+exec…", n)
	results := make([]result, n)
	var wg sync.WaitGroup
	start := time.Now()

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sandboxID := fmt.Sprintf("sb-harness-%d-%d", start.UnixNano(), i)

			claimStart := time.Now()
			entry, ok := pool.Claim()
			results[i].claim = time.Since(claimStart)
			if !ok {
				results[i].err = fmt.Errorf("pool empty")
				return
			}
			results[i].sandboxID = sandboxID

			// Track is what the edge-claim path does: bind a pre-launched box to
			// a sandbox id without any AWS call.
			mgr.TrackClaimed(sandboxID, entry, types.SandboxConfig{
				SandboxID: sandboxID,
				Template:  "microvm",
			})

			for n := 0; n < execs; n++ {
				execStart := time.Now()
				res, err := mgr.Exec(ctx, sandboxID, types.ProcessConfig{
					Command: command,
					Timeout: 30,
				})
				took := time.Since(execStart)
				if n == 0 {
					results[i].exec = took
				} else {
					results[i].warm = append(results[i].warm, took)
				}
				if err != nil {
					results[i].err = err
					return
				}
				if res.ExitCode != 0 {
					results[i].err = fmt.Errorf("exit %d: %s", res.ExitCode, res.Stderr)
					return
				}
				results[i].stdout = res.Stdout
			}
		}(i)
	}
	wg.Wait()
	log.Printf("burst wall-clock: %s", time.Since(start).Round(time.Millisecond))
	return results
}

// probeProxy isolates "can the proxy reach the guest at all" from "does gRPC
// work through the proxy".
//
// The hook server serves plain HTTP /healthz on port 8080 — the same port and
// process Lambda already talks to successfully during the image build. If a
// plain GET through the proxy succeeds while gRPC on 8081 returns 502, the
// problem is gRPC or that specific port. If BOTH 502, the guest is not
// admitting proxied traffic at all and the transport is not the issue.
func probeProxy(ctx context.Context, awsCfg aws.Config, region, image string, pool *awsvm.Pool) {
	entry, ok := pool.Claim()
	if !ok {
		log.Fatal("probe: pool empty")
	}

	for _, port := range []int32{hookPort, agentPort} {
		// Tokens are port-scoped, so each probe needs one minted for its port.
		c := awsvm.NewClient(awsCfg, awsvm.Config{
			Region: region, ImageIdentifier: image, AgentPort: port,
		})
		token, err := c.AuthToken(ctx, entry.MicrovmID)
		if err != nil {
			log.Printf("probe port %d: mint token: %v", port, err)
			continue
		}

		path := "/healthz"
		if port == agentPort {
			// Nothing serves plain HTTP here; we only care which error comes
			// back — a proxy 502 versus anything originating in the guest.
			path = "/"
		}
		url := awsvm.AgentURL(entry.Endpoint) + path
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			log.Printf("probe port %d: %v", port, err)
			continue
		}
		req.Header.Set("X-aws-proxy-auth", token)
		req.Header.Set("X-aws-proxy-port", fmt.Sprintf("%d", port))

		start := time.Now()
		resp, err := http.DefaultClient.Do(req)
		took := time.Since(start).Round(time.Millisecond)
		if err != nil {
			log.Printf("probe port %d %s → transport error after %s: %v", port, path, took, err)
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		resp.Body.Close()
		// Print the body verbatim rather than trimmed: on the hook port it is
		// the guest's self-report, which is the whole point of the probe.
		log.Printf("probe port %d %s → HTTP %d in %s (proto=%s) %s",
			port, path, resp.StatusCode, took, resp.Proto, strings.TrimSpace(string(body)))
	}
	// Does an unannounced HTTP/2 trailer survive the proxy? gRPC carries its
	// status that way, so a "no" here means gRPC cannot work through Lambda at
	// all and the agent transport has to change; a "yes" means the trailer loss
	// is ours to fix inside the guest.
	c := awsvm.NewClient(awsCfg, awsvm.Config{Region: region, ImageIdentifier: image, AgentPort: hookPort})
	if token, err := c.AuthToken(ctx, entry.MicrovmID); err == nil {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
			awsvm.AgentURL(entry.Endpoint)+"/trailer-test", nil)
		req.Header.Set("X-aws-proxy-auth", token)
		req.Header.Set("X-aws-proxy-port", fmt.Sprintf("%d", hookPort))
		if resp, err := http.DefaultClient.Do(req); err != nil {
			log.Printf("trailer probe: %v", err)
		} else {
			// Trailers are only populated after the body is drained.
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			got := resp.Trailer.Get("X-Osb-Trailer")
			if got == "" {
				log.Printf("trailer probe: TRAILER LOST through the proxy (trailers=%v) → gRPC cannot work as-is", resp.Trailer)
			} else {
				log.Printf("trailer probe: trailer survived (X-Osb-Trailer=%q) → proxy is fine, our bridge drops them", got)
			}
		}
	}

	// Does a WebSocket survive the proxy, and does it stream both ways? If so,
	// gRPC can be tunnelled inside one and the agent's entire API keeps working
	// unchanged despite trailers being stripped.
	if token, err := c.AuthToken(ctx, entry.MicrovmID); err == nil {
		wsURL := "wss://" + hostOnly(entry.Endpoint) + "/ws-test"
		hdr := http.Header{}
		hdr.Set("X-aws-proxy-auth", token)
		hdr.Set("X-aws-proxy-port", fmt.Sprintf("%d", hookPort))

		start := time.Now()
		conn, resp, err := websocket.DefaultDialer.DialContext(ctx, wsURL, hdr)
		if err != nil {
			status := 0
			if resp != nil {
				status = resp.StatusCode
			}
			log.Printf("ws probe: upgrade FAILED (http=%d): %v → gRPC-over-WebSocket is not available either", status, err)
		} else {
			defer conn.Close()
			payload := []byte("hello-microvm")
			_ = conn.WriteMessage(websocket.TextMessage, payload)
			_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
			_, got, rerr := conn.ReadMessage()
			rtt := time.Since(start).Round(time.Millisecond)
			if rerr != nil {
				log.Printf("ws probe: upgraded but echo failed after %s: %v", rtt, rerr)
			} else if string(got) == string(payload) {
				log.Printf("ws probe: OK — upgrade + round-trip echo in %s → gRPC can be tunnelled over WebSocket", rtt)
			} else {
				log.Printf("ws probe: echo mismatch (%q)", string(got))
			}
		}
	}

	log.Printf("probe: microvm=%s endpoint=%s", entry.MicrovmID, entry.Endpoint)
}

func report(results []result) {
	var claims, cold, warm []time.Duration
	ok := 0
	fmt.Println()
	fmt.Println("── per-sandbox ─────────────────────────────────────────────")
	for _, r := range results {
		status := "ok"
		if r.err != nil {
			status = "FAIL: " + r.err.Error()
		} else {
			ok++
			cold = append(cold, r.exec)
			warm = append(warm, r.warm...)
		}
		claims = append(claims, r.claim)
		fmt.Printf("  claim=%-9s exec=%-9s %s %s\n",
			r.claim.Round(time.Microsecond), r.exec.Round(time.Millisecond), status, trim(r.stdout))
	}

	fmt.Println()
	fmt.Println("── summary ─────────────────────────────────────────────────")
	fmt.Printf("  success:     %d/%d\n", ok, len(results))
	printStats("claim", claims)
	printStats("cold ", cold)
	printStats("warm ", warm)
	fmt.Println()
	if ok == 0 {
		// The single most important negative result this harness can produce.
		fmt.Println("  NO EXEC SUCCEEDED — if the errors are transport-level, gRPC")
		fmt.Println("  does not survive the Lambda proxy and the agent transport")
		fmt.Println("  must change. Check whether the failures are gRPC status")
		fmt.Println("  codes (reached the agent) or dial/TLS errors (did not).")
	}
}

func printStats(label string, ds []time.Duration) {
	if len(ds) == 0 {
		fmt.Printf("  %s:       (none)\n", label)
		return
	}
	sorted := append([]time.Duration(nil), ds...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	at := func(q float64) time.Duration {
		idx := int(q * float64(len(sorted)-1))
		return sorted[idx].Round(time.Millisecond)
	}
	fmt.Printf("  %s:       min=%s med=%s p95=%s max=%s\n",
		label, sorted[0].Round(time.Millisecond), at(0.5), at(0.95), sorted[len(sorted)-1].Round(time.Millisecond))
}

// hostOnly strips the scheme so the endpoint can be rebuilt as wss://.
func hostOnly(endpoint string) string {
	return strings.TrimPrefix(awsvm.AgentURL(endpoint), "https://")
}

// trim renders command output on a single line so the per-sandbox table stays
// readable when a command is chatty.
func trim(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 60 {
		s = s[:60] + "…"
	}
	return strings.NewReplacer("\n", " ", "\r", " ").Replace(s)
}

// ── suspend/resume ──────────────────────────────────────────────────────────

// resumeResult is one box's wake timings.
//
// The three are separated because only the last one is what a customer feels.
// ResumeMicrovm returning is not the same as the box being RUNNING, and RUNNING
// is not the same as the agent answering — a wake design that quotes the API
// call latency would understate the real number by whatever the tail costs.
type resumeResult struct {
	suspend   time.Duration // SuspendMicrovm call
	resumeAPI time.Duration // ResumeMicrovm call returns
	toRunning time.Duration // ...until GetMicrovm reports RUNNING
	toExec    time.Duration // ...until an exec actually succeeds
	err       error
}

// runResumeBench measures the cost of the fast-wake tier: claim boxes, warm
// them, suspend them, then wake them and time how long until each is usable.
//
// This is the number the hibernation design turns on. If resume is close to a
// cold create (~1.5s) there is little reason to hold a suspended box at all —
// it consumes regional memory quota, which is the ceiling on pool depth — and
// the tier should be dropped in favour of always exporting to blob. If resume
// is much faster, the tier earns its quota.
func runResumeBench(ctx context.Context, client *awsvm.Client, pool *awsvm.Pool, mgr *awsvm.Manager, n int, command string) {
	log.Printf("resume-bench: claiming %d box(es)", n)
	type box struct {
		sandboxID string
		microvmID string
	}
	boxes := make([]box, 0, n)
	for i := 0; i < n; i++ {
		e, ok := pool.Claim()
		if !ok {
			log.Printf("resume-bench: pool exhausted at %d", i)
			break
		}
		sid := fmt.Sprintf("sb-resume-%d", i)
		mgr.TrackClaimed(sid, e, types.SandboxConfig{SandboxID: sid})
		boxes = append(boxes, box{sandboxID: sid, microvmID: e.MicrovmID})
	}
	if len(boxes) == 0 {
		log.Printf("resume-bench: nothing claimed")
		return
	}

	// Warm each channel first. Measuring a resume through a cold agent tunnel
	// would fold the tunnel setup into the wake number and overstate it.
	for _, b := range boxes {
		if _, err := mgr.Exec(ctx, b.sandboxID, types.ProcessConfig{Command: "sh", Args: []string{"-c", command}}); err != nil {
			log.Printf("resume-bench: warm exec %s: %v", b.sandboxID, err)
		}
	}

	results := make([]resumeResult, len(boxes))
	for i, b := range boxes {
		var r resumeResult

		t := time.Now()
		if err := client.Suspend(ctx, b.microvmID); err != nil {
			r.err = fmt.Errorf("suspend: %w", err)
			results[i] = r
			continue
		}
		r.suspend = time.Since(t)

		// Wait for it to actually reach SUSPENDED, or we would be timing a
		// resume against a box that never finished suspending.
		for wait := time.Now(); time.Since(wait) < 60*time.Second; {
			bx, err := client.Get(ctx, b.microvmID)
			if err == nil && bx.State == awsTypes.MicrovmStateSuspended {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}

		t = time.Now()
		if err := client.Resume(ctx, b.microvmID); err != nil {
			r.err = fmt.Errorf("resume: %w", err)
			results[i] = r
			continue
		}
		r.resumeAPI = time.Since(t)

		for wait := time.Now(); time.Since(wait) < 60*time.Second; {
			bx, err := client.Get(ctx, b.microvmID)
			if err == nil && bx.State == awsTypes.MicrovmStateRunning {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		r.toRunning = time.Since(t)

		for wait := time.Now(); time.Since(wait) < 90*time.Second; {
			if _, err := mgr.Exec(ctx, b.sandboxID, types.ProcessConfig{Command: "sh", Args: []string{"-c", "echo woke"}}); err == nil {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		r.toExec = time.Since(t)
		results[i] = r
		log.Printf("  %s suspend=%s resumeAPI=%s toRunning=%s toExec=%s",
			b.sandboxID, r.suspend.Round(time.Millisecond), r.resumeAPI.Round(time.Millisecond),
			r.toRunning.Round(time.Millisecond), r.toExec.Round(time.Millisecond))
	}

	var suspends, apis, runnings, execs []time.Duration
	for _, r := range results {
		if r.err != nil {
			log.Printf("resume-bench: %v", r.err)
			continue
		}
		suspends = append(suspends, r.suspend)
		apis = append(apis, r.resumeAPI)
		runnings = append(runnings, r.toRunning)
		execs = append(execs, r.toExec)
	}
	log.Printf("── resume-bench (n=%d) ──", len(execs))
	printStats("SuspendMicrovm call", suspends)
	printStats("ResumeMicrovm call", apis)
	printStats("resume -> RUNNING", runnings)
	printStats("resume -> exec OK", execs)

	for _, b := range boxes {
		_ = mgr.Kill(context.WithoutCancel(ctx), b.sandboxID)
	}
}

// ── hibernate/wake lifecycle ────────────────────────────────────────────────

// runLifecycleSim measures the full hibernation cycle against real MicroVMs:
// claim a box, write a workspace of a known size, hibernate it (export+upload+
// suspend), then wake it both ways and check the files actually came back.
//
// It exists to settle the one number the hibernation design still turns on:
// what a blob restore costs. Resume measured ~1.04s and a pooled claim ~0ms, so
// if restore is cheap the suspended tier is buying almost nothing and can be
// dropped; if it is expensive the tier earns the regional memory quota it
// holds. No amount of reasoning settles that — only the archive round trip on
// a realistic workspace does.
func runLifecycleSim(ctx context.Context, client *awsvm.Client, pool *awsvm.Pool, mgr *awsvm.Manager,
	store *storage.CheckpointStore, sizeMB int) {

	e, ok := pool.Claim()
	if !ok {
		log.Printf("lifecycle: pool empty")
		return
	}
	sid := "sb-lifecycle"
	mgr.TrackClaimed(sid, e, types.SandboxConfig{SandboxID: sid})
	defer func() { _ = mgr.Kill(context.WithoutCancel(ctx), sid) }()

	// A known payload, so the restore can be verified rather than assumed. A
	// wake that silently returns an empty workspace is the failure this whole
	// design exists to prevent, and it would look identical to success.
	log.Printf("lifecycle: seeding %dMB workspace", sizeMB)
	seed := time.Now()
	if _, err := mgr.Exec(ctx, sid, types.ProcessConfig{Command: "sh", Args: []string{"-c",
		fmt.Sprintf("mkdir -p %s/data && head -c %d /dev/urandom > %s/data/blob.bin && "+
			"echo canary-12345 > %s/data/canary.txt && sha256sum %s/data/blob.bin | cut -d' ' -f1",
			workspaceGuestDir, sizeMB<<20, workspaceGuestDir, workspaceGuestDir, workspaceGuestDir)},
	}); err != nil {
		log.Printf("lifecycle: seed failed: %v", err)
		return
	}
	log.Printf("  seeded in %s", time.Since(seed).Round(time.Millisecond))

	// Hibernate: tar + upload + suspend.
	t := time.Now()
	res, err := mgr.Hibernate(ctx, sid, store)
	if err != nil {
		log.Printf("lifecycle: hibernate failed: %v", err)
		return
	}
	hibDur := time.Since(t)
	log.Printf("  hibernate (tar+upload+suspend): %s  archive=%dB key=%s",
		hibDur.Round(time.Millisecond), res.SizeBytes, res.HibernationKey)

	// Wake A — the box is still suspended, so this is the fast tier.
	t = time.Now()
	if _, err := mgr.Wake(ctx, sid, res.HibernationKey, store, 0); err != nil {
		log.Printf("lifecycle: fast wake failed: %v", err)
		return
	}
	fastWake := time.Since(t)
	verify(ctx, mgr, sid, "fast wake")
	log.Printf("  WAKE (resume, box alive): %s", fastWake.Round(time.Millisecond))

	// Now retire the box the way the expiry sweep would, and wake from blob
	// alone. This is the tier a sandbox lands in after the dwell.
	if err := client.Terminate(ctx, e.MicrovmID); err != nil {
		log.Printf("lifecycle: terminate for deep-wake test: %v", err)
		return
	}
	mgr.Forget(sid)

	t = time.Now()
	if _, err := mgr.Wake(ctx, sid, res.HibernationKey, store, 0); err != nil {
		log.Printf("lifecycle: deep wake failed: %v", err)
		return
	}
	deepWake := time.Since(t)
	ok2 := verify(ctx, mgr, sid, "deep wake")
	log.Printf("  WAKE (restore from blob): %s  filesIntact=%v", deepWake.Round(time.Millisecond), ok2)

	log.Printf("── lifecycle (%dMB workspace) ──", sizeMB)
	log.Printf("  hibernate      %s", hibDur.Round(time.Millisecond))
	log.Printf("  wake resume    %s", fastWake.Round(time.Millisecond))
	log.Printf("  wake restore   %s", deepWake.Round(time.Millisecond))
	log.Printf("  delta          %s  (what the suspended tier buys)", (deepWake - fastWake).Round(time.Millisecond))
}

// workspaceGuestDir mirrors awsvm's workspaceDir; the harness cannot import an
// unexported constant, and hardcoding it here means a divergence shows up as a
// failed verification rather than a silent no-op.
const workspaceGuestDir = "/home/sandbox"

// verify checks the canary survived the round trip. Size alone proves nothing:
// an empty archive restores "successfully" and reports a plausible duration.
func verify(ctx context.Context, mgr *awsvm.Manager, sid, label string) bool {
	res, err := mgr.Exec(ctx, sid, types.ProcessConfig{Command: "sh", Args: []string{"-c",
		fmt.Sprintf("cat %s/data/canary.txt 2>/dev/null; stat -c %%s %s/data/blob.bin 2>/dev/null",
			workspaceGuestDir, workspaceGuestDir)}})
	if err != nil {
		log.Printf("  %s: verify exec failed: %v", label, err)
		return false
	}
	if !strings.Contains(res.Stdout, "canary-12345") {
		log.Printf("  %s: CANARY MISSING — workspace did not survive: %q", label, trim(res.Stdout))
		return false
	}
	return true
}
