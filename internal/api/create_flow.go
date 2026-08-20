package api

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/awsvm"
)

// createTimingLogThreshold is the total above which runCreate logs its per-step
// breakdown. A warm pooled claim lands well under this, so steady state stays
// silent and only creates worth explaining show up.
const createTimingLogThreshold = 50 * time.Millisecond

// create_flow.go — the order a sandbox comes into existence, independent of the
// runtime that hosts it.
//
// Every backend runs the same five steps, and the order is not stylistic:
//
//	claim    choose a host — no side effects, so a failure here costs nothing
//	persist  write the pending row BEFORE the host boots; the QEMU worker reads
//	         org_id out of it while starting the VM, so a later write races the
//	         thing that depends on it
//	activate start the host (no-op for a backend whose hosts already run)
//	promote  pending → running, the point at which the sandbox is real
//	cleanup  on activate failure, close the row out rather than leaving it
//	         pending forever — a stuck pending row holds an open scale event and
//	         bills until something else notices
//
// Sequencing lives here, apart from the HTTP handler, because the handler needs
// a database and a worker registry to run at all and the ordering invariants
// need neither. Before this the whole sequence was inline in createSandboxRemote
// and had no test: the persist-before-activate constraint was a comment.

// createSteps is the runtime-specific half of a create. Each step is a closure
// so the sequencer needs no knowledge of PG, gRPC, or any provider SDK.
type createSteps struct {
	// claim chooses a host and returns the worker_id to persist.
	claim func(ctx context.Context) (workerID string, err error)
	// persist writes the pending session row.
	persist func(ctx context.Context, workerID string) error
	// persistRequired makes a persist failure fatal, running cleanup and
	// failing the create.
	//
	// Set it when the row is the only record that this sandbox exists. A
	// backend that can enumerate what it is running reconciles a missing row
	// later, so losing one is a temporary gap; a backend that rebuilds its view
	// *from* these rows cannot, so an unwritten row is a host nothing will ever
	// reclaim — it bills and holds capacity until its hard lifetime cap.
	persistRequired bool
	// activate starts the host. Nil means nothing to start.
	activate func(ctx context.Context, workerID string) error
	// promote marks the sandbox running.
	promote func(ctx context.Context, workerID string) error
	// cleanup runs when activate fails, with the cause. Nil skips it.
	cleanup func(ctx context.Context, workerID string, cause error)
	// deferPersist moves persist+promote off the request, running them after
	// the caller already has its answer.
	//
	// Only safe for a backend whose claim has ALREADY made the sandbox usable
	// in-process — the MicroVM backend binds sandbox→box and adopts the warm
	// tunnel inside Claim, so exec, destroy and routing all work the instant
	// Claim returns. The row is bookkeeping consumed by restart recovery and
	// billing, neither of which cares about a few hundred milliseconds.
	//
	// Measured: those two writes were 230ms of a 450ms create — over half the
	// customer-visible latency spent on a row nobody reads during the request.
	//
	// The safety net is what makes this defensible rather than reckless: a
	// write that fails leaves a box the runtime still knows about, which the
	// reconciler adopts from AWS and the orphan sweep reclaims if it does not.
	// Without both of those this would be a quota leak generator.
	deferPersist bool
}

// runCreate executes the steps in the one order that is correct.
//
// Returns the first error and stops: a create that could not claim must not
// persist, and one that could not activate must not promote. Both mistakes
// produce a row the system believes in and no host behind it.
func runCreate(ctx context.Context, sandboxID string, steps createSteps) (workerID string, err error) {
	// Per-step timings. The four steps have wildly different costs depending on
	// backend — a pooled MicroVM claim is an in-memory pop while persist is two
	// Postgres writes — and the request log only reports the total, which left
	// a 200ms create unattributable. Logged above a threshold so the normal
	// path stays quiet.
	start := time.Now()
	var claimMs, persistMs, activateMs, promoteMs int64
	defer func() {
		total := time.Since(start)
		if total >= createTimingLogThreshold {
			log.Printf("create: %s timings total=%dms claim=%dms persist=%dms activate=%dms promote=%dms",
				sandboxID, total.Milliseconds(), claimMs, persistMs, activateMs, promoteMs)
		}
	}()

	t := time.Now()
	workerID, err = steps.claim(ctx)
	claimMs = time.Since(t).Milliseconds()
	if err != nil {
		return "", err
	}

	// Deferred-persist backends run activate on the request and everything
	// durable behind it. Activate stays inline because it is the step that can
	// still fail the create; the writes cannot, by construction.
	if steps.deferPersist {
		if steps.activate != nil {
			t = time.Now()
			aerr := steps.activate(ctx, workerID)
			activateMs = time.Since(t).Milliseconds()
			if aerr != nil {
				if steps.cleanup != nil {
					steps.cleanup(ctx, workerID, aerr)
				}
				return "", fmt.Errorf("create: activate %s on %s: %w", sandboxID, workerID, aerr)
			}
		}
		go persistAfterResponse(sandboxID, workerID, steps)
		return workerID, nil
	}

	if steps.persist != nil {
		t = time.Now()
		err := steps.persist(ctx, workerID)
		persistMs = time.Since(t).Milliseconds()
		if err != nil {
			if steps.persistRequired {
				// Nothing else knows this host exists, so continuing would hand
				// out a sandbox no sweep can ever reclaim.
				if steps.cleanup != nil {
					steps.cleanup(ctx, workerID, err)
				}
				return "", fmt.Errorf("create: persist %s on %s: %w", sandboxID, workerID, err)
			}
			// Otherwise survivable: the host exists and the customer can use it,
			// and the row is reconciled later from the runtime's own view.
			// Failing here instead would strand a running host over a database
			// blip, which is strictly worse than a missing row.
			log.Printf("create: persist failed for %s on %s: %v — continuing, reconciler will settle it",
				sandboxID, workerID, err)
		}
	}

	if steps.activate != nil {
		t = time.Now()
		err := steps.activate(ctx, workerID)
		activateMs = time.Since(t).Milliseconds()
		if err != nil {
			if steps.cleanup != nil {
				steps.cleanup(ctx, workerID, err)
			}
			return "", fmt.Errorf("create: activate %s on %s: %w", sandboxID, workerID, err)
		}
	}

	if steps.promote != nil {
		t = time.Now()
		err := steps.promote(ctx, workerID)
		promoteMs = time.Since(t).Milliseconds()
		if err != nil {
			// The sandbox is up; only the row lags. Same reasoning as persist.
			log.Printf("create: promote failed for %s on %s: %v", sandboxID, workerID, err)
		}
	}
	return workerID, nil
}

// persistDeferTimeout bounds the background write. Generous — the customer is
// not waiting — but finite, so a wedged database cannot accumulate goroutines
// for every create the cell serves.
const persistDeferTimeout = 30 * time.Second

// persistAfterResponse writes the session row once the customer already has
// their sandbox. Runs on its own context: the request's is cancelled the moment
// the response is flushed, which would abort every one of these writes.
//
// Failures are logged, not retried here. The reconciler adopts a live box whose
// row is missing, and the orphan sweep reclaims one nothing adopts — retrying
// against a database that just failed is less reliable than the sweep that
// exists for precisely this case.
func persistAfterResponse(sandboxID, workerID string, steps createSteps) {
	ctx, cancel := context.WithTimeout(context.Background(), persistDeferTimeout)
	defer cancel()

	start := time.Now()
	if steps.persist != nil {
		if err := steps.persist(ctx, workerID); err != nil {
			log.Printf("create: deferred persist failed for %s on %s: %v — reconciler will settle it",
				sandboxID, workerID, err)
			// Skip promote: flipping a row to running that was never inserted
			// is a no-op at best and a confusing partial write at worst.
			return
		}
	}
	if steps.promote != nil {
		if err := steps.promote(ctx, workerID); err != nil {
			log.Printf("create: deferred promote failed for %s on %s: %v", sandboxID, workerID, err)
			return
		}
	}
	if d := time.Since(start); d >= createTimingLogThreshold {
		log.Printf("create: %s deferred writes took %dms (off the request path)", sandboxID, d.Milliseconds())
	}
}

// respondCreateErr answers a failed create, separating "we are full" from "we
// are being asked too fast" from "that host is restarting" from everything else.
//
// The distinction is the whole point: these are different problems with
// different answers — one needs capacity added, one clears in under a second,
// one clears as soon as another host is picked. Collapsing them into a generic
// 503 leaves a client unable to choose between retrying and giving up.
//
// Every message here is what the customer reads, so none of them names the
// runtime that failed. Which backend was serving the create is our problem, and
// it changes; the log line beside each one carries that detail instead.
func respondCreateErr(c echo.Context, err error) error {
	switch {
	case errors.Is(err, awsvm.ErrQuotaExceeded), errors.Is(err, ErrNoCapacity):
		// No Retry-After: retrying does not help until a sandbox is released or
		// capacity is added, and inviting a retry storm at a full region only
		// adds rate limiting on top of exhaustion.
		log.Printf("create: OUT OF CAPACITY: %v", err)
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "out of capacity: no sandbox capacity is currently available in this region",
			"hint":  "retry once a sandbox is released, or contact support to raise your capacity",
		})

	case errors.Is(err, awsvm.ErrThrottled):
		// Transient by construction — say so, and give a concrete delay so
		// clients space retries instead of hammering.
		log.Printf("create: rate limited: %v", err)
		c.Response().Header().Set("Retry-After", "1")
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "sandbox creation is temporarily rate limited, retry shortly",
		})

	case isTransientWorkerErr(err):
		// The chosen host is restarting or unreachable. Retrying reselects, so
		// this must be retryable rather than a 500 that reads as our bug.
		log.Printf("create: host unavailable: %v", err)
		c.Response().Header().Set("Retry-After", "2")
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "sandbox capacity is temporarily unavailable, please retry",
			"code":  "host_unavailable",
		})

	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		log.Printf("create: timed out: %v", err)
		return c.JSON(http.StatusGatewayTimeout, map[string]string{
			"error": "timed out starting the sandbox",
		})
	}

	log.Printf("create: failed: %v", err)
	return c.JSON(http.StatusInternalServerError, map[string]string{
		"error": "failed to start the sandbox",
	})
}
