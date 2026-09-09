package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/awsvm"
)

// microvm_common.go — the parts of the MicroVM runtime that are not specific to
// how we talk to a box.
//
// There used to be two MicroVM backends: an agent-tunnel one (a gRPC channel
// held per box, brokered by the control plane) and the direct-exec "lite" one
// in lite_backend.go. The tunnel backend is gone; lite is the runtime. What
// survives here is everything that was never about the tunnel — enabling the
// runtime, building the AWS client, and the worker_id encoding that outlives
// any single backend because it is written into rows, D1, and the dashboard.

// microvmEnabled reports whether this cell serves MicroVM-backed sandboxes.
// Off unless explicitly turned on: this backend is regional (us-east-1 today)
// and cannot serve a cell whose customers expect QEMU semantics like fork,
// which it does not implement.
func microvmEnabled() bool {
	return os.Getenv("OPENSANDBOX_MICROVM_ENABLED") == "1"
}

// newMicrovmClient builds the AWS client from environment config.
func newMicrovmClient(ctx context.Context) (*awsvm.Client, error) {
	image := os.Getenv("OPENSANDBOX_MICROVM_IMAGE_ARN")
	if image == "" {
		return nil, fmt.Errorf("OPENSANDBOX_MICROVM_ENABLED=1 but OPENSANDBOX_MICROVM_IMAGE_ARN is unset")
	}
	region := os.Getenv("OPENSANDBOX_MICROVM_REGION")
	if region == "" {
		region = "us-east-1"
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("microvm: load AWS config: %w", err)
	}

	// Idle policy. Measured on dev: with idle=60s and suspended=300s, a sandbox
	// was TERMINATED — disk and all — roughly six minutes after its last
	// request. The old defaults (900/1800) put that at 45 minutes of inactivity,
	// which silently destroys any sandbox a customer steps away from.
	//
	//   idle      seconds without inbound proxy traffic before AWS suspends.
	//   suspended seconds a box may stay suspended before AWS TERMINATES it.
	//             This, not the 8h ceiling, is what actually bounds a parked
	//             sandbox, and when it fires the disk goes with it.
	//   resume    whether an inbound request wakes a suspended box. With this
	//             off, nothing can reach a box during its suspended window, so
	//             the window always runs out and the sandbox is destroyed.
	//
	// Both default to the 8h hard ceiling so neither timer fires before the cap
	// does, leaving the cap as the single deadline to reason about — and the one
	// the blob promotion works against. Auto-resume defaults ON so that anything
	// which does suspend is recoverable rather than doomed.
	idleSec := envInt("OPENSANDBOX_MICROVM_IDLE_SECONDS", 28_800)
	suspendedSec := envInt("OPENSANDBOX_MICROVM_SUSPENDED_SECONDS", 28_800)
	autoResume := os.Getenv("OPENSANDBOX_MICROVM_AUTO_RESUME") != "0"
	sizeImages := parseSizeImages(os.Getenv("OPENSANDBOX_MICROVM_SIZE_IMAGES"))
	defaultMemoryMB := envInt("OPENSANDBOX_MICROVM_DEFAULT_MEMORY_MB", 0)
	// Empty pins nothing and takes the image's latest active version, which is
	// what production wants. Setting it is for A/B: a republished image changes
	// every box in the fleet at once, so without a way to pin an older version
	// there is no way to tell "the image regressed" from "something else did".
	imageVersion := os.Getenv("OPENSANDBOX_MICROVM_IMAGE_VERSION")
	client := awsvm.NewClient(awsCfg, awsvm.Config{
		Region:                   region,
		ImageIdentifier:          image,
		ImageVersion:             imageVersion,
		DefaultMemoryMB:          defaultMemoryMB,
		SizeImages:               sizeImages,
		ExecutionRoleArn:         os.Getenv("OPENSANDBOX_MICROVM_EXECUTION_ROLE_ARN"),
		MaxIdleDurationSeconds:   int32(idleSec),
		SuspendedDurationSeconds: int32(suspendedSec),
		AutoResume:               autoResume,
	})
	if len(sizeImages) > 0 {
		log.Printf("microvm: size tiers — default %dMB pooled, cold-only: %v",
			client.Config().DefaultMemoryMB, sortedTiers(sizeImages))
	}
	log.Printf("microvm: idle policy — suspend after %ds idle, terminate after %ds suspended, auto-resume=%v",
		idleSec, suspendedSec, autoResume)
	if imageVersion != "" {
		log.Printf("microvm: image version PINNED to %s (unset OPENSANDBOX_MICROVM_IMAGE_VERSION for latest)", imageVersion)
	}

	return client, nil
}

// ── worker_id encoding ──────────────────────────────────────────────────────
//
// A MicroVM has no worker, so worker_id carries the host id instead. Reusing
// the column rather than adding one is deliberate — it is the only durable link
// between our sandbox id and the host, and without it a control-plane restart
// loses the mapping: the sandboxes become unroutable AND unreapable, billing
// compute until the hard duration cap.
//
// worker_id travels well beyond the database — it is returned in the create
// response, written to D1 sandboxes_index, and rendered in the dashboard — so
// both halves of it are ours to choose, and neither describes the runtime.
const microvmWorkerPrefix = "vmhost:"

// legacyWorkerPrefix is still read so rows predating the current encoding stay
// routable and reapable; dropping it would strand those hosts billing until
// their duration cap with nothing able to parse, reconcile, or terminate them.
// Never written.
const legacyWorkerPrefix = "microvm:"

// hostIDPrefix is the fixed prefix the platform puts on every host id. Trimmed
// on the way into worker_id and restored on the way out, so the id we publish
// is ours end to end while the value we hand back to the platform is unchanged.
// A host id that does not carry it is stored verbatim.
const hostIDPrefix = "microvm-"

// microvmPublisherWorkerID is the event publisher's fallback stamp, used only
// for a sandbox whose host binding is already gone from memory — which in
// practice means its final flush during shutdown or after a reconcile drop.
// The per-sandbox resolver supplies the real owner in every other case.
const microvmPublisherWorkerID = "vmhost-cp"

// microvmWorkerID encodes a host id for storage in worker_id.
func microvmWorkerID(microvmID string) string {
	return microvmWorkerPrefix + strings.TrimPrefix(microvmID, hostIDPrefix)
}

// parseMicrovmWorkerID recovers the host id, reporting whether the row is
// backed by this runtime at all.
func parseMicrovmWorkerID(workerID string) (string, bool) {
	for _, prefix := range []string{microvmWorkerPrefix, legacyWorkerPrefix} {
		if !strings.HasPrefix(workerID, prefix) {
			continue
		}
		id := strings.TrimPrefix(workerID, prefix)
		if id == "" {
			return "", false
		}
		// Rows stored before the id was trimmed already carry it.
		if !strings.HasPrefix(id, hostIDPrefix) {
			id = hostIDPrefix + id
		}
		return id, true
	}
	return "", false
}

// respondManagerErr maps a manager error to a response.
//
// The distinction matters to callers: a 500 invites a retry and reads as our
// bug, while 501 says the operation will never succeed on this runtime. The
// MicroVM runtime returns ErrUnsupported for fork and for SetResourceLimits
// (sizing belongs to the image, so there is no per-sandbox knob to turn).
func respondManagerErr(c echo.Context, err error) error {
	if errors.Is(err, awsvm.ErrUnsupported) {
		return c.JSON(http.StatusNotImplemented, map[string]string{
			"error": "this operation is not supported for this sandbox",
		})
	}
	// Logged, not returned: internal errors carry upstream service names,
	// resource ids, and wording.
	log.Printf("microvm: operation failed: %v", err)
	return c.JSON(http.StatusInternalServerError, map[string]string{
		"error": "the sandbox could not complete this operation",
	})
}

// parseSizeImages reads the tier→image map from
// OPENSANDBOX_MICROVM_SIZE_IMAGES, formatted "1024=arn:...,8192=arn:...".
//
// Only tiers listed here are offered beyond the default; an unlisted size is
// refused at create rather than served from the default image. Malformed
// entries are dropped with a log rather than failing startup — a typo in one
// tier must not take the whole cell down, but it must not silently become a
// wrong-size sandbox either, and dropping it makes that tier 501 instead.
func parseSizeImages(raw string) map[int]string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	out := map[int]string{}
	for _, pair := range strings.Split(raw, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		k, v, found := strings.Cut(pair, "=")
		mb, err := strconv.Atoi(strings.TrimSpace(k))
		if !found || err != nil || mb <= 0 || strings.TrimSpace(v) == "" {
			log.Printf("microvm: ignoring malformed SIZE_IMAGES entry %q — that tier will be refused, not downsized", pair)
			continue
		}
		out[mb] = strings.TrimSpace(v)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// sortedTiers lists configured tier sizes in ascending order, for logging.
func sortedTiers(m map[int]string) []int {
	out := make([]int, 0, len(m))
	for mb := range m {
		out = append(out, mb)
	}
	sort.Ints(out)
	return out
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
		log.Printf("microvm: ignoring malformed %s=%q, using %d", key, v, def)
	}
	return def
}

// microvmReconcileInterval is how often the backend re-checks its bindings
// against the platform. Nothing else ever notices one of these boxes dying —
// no worker reports in for them — so this ticker is the only liveness signal
// the control plane has for the runtime.
const microvmReconcileInterval = 5 * time.Minute
