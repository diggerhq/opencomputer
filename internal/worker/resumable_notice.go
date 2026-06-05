package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// NotifyResumableSandboxesBeforeRestart runs the same in-guest notice hook used
// by cloud preemption handling. It gives resumable sandboxes a bounded window
// to flush state to disk before the host restarts.
func NotifyResumableSandboxesBeforeRestart(ctx context.Context, mgr sandbox.Manager, store *db.Store, sandboxDBs *sandbox.SandboxDBManager, noticeWindow time.Duration, eta time.Time) int {
	if mgr == nil {
		return 0
	}
	wait := noticeWindow
	if !eta.IsZero() {
		until := time.Until(eta)
		switch {
		case until <= 0:
			wait = 0
		case until <= 5*time.Second:
			wait = until
		case until-5*time.Second < wait:
			wait = until - 5*time.Second
		}
	}
	if wait < 0 {
		wait = 0
	}

	listCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	sandboxes, err := mgr.List(listCtx)
	cancel()
	if err != nil {
		log.Printf("opensandbox-worker: resumable restart notice: failed to list sandboxes: %v", err)
		sleepContext(ctx, wait)
		return 0
	}

	started := time.Now()
	noticeSeconds := int(wait.Seconds())
	if noticeSeconds < 0 {
		noticeSeconds = 0
	}
	hookTimeout := noticeSeconds
	if hookTimeout <= 0 {
		hookTimeout = 1
	}
	if hookTimeout > 20 {
		hookTimeout = 20
	}

	const restartNoticeScript = `notice="${OPENSANDBOX_RESUME_NOTICE_SECONDS:-25}"
export OPENSANDBOX_RESTART_NOTICE_SECONDS="$notice"
for hook in /etc/opencomputer/on-restart-notice /home/sandbox/.opencomputer/on-restart-notice; do
  if [ -x "$hook" ]; then
    "$hook" "$notice"
  fi
done
sync`

	var wg sync.WaitGroup
	notified := 0
	for _, sb := range sandboxes {
		if sb.Status != "" && sb.Status != "running" {
			continue
		}
		if !isResumableSandboxSession(ctx, store, sb.ID) {
			continue
		}

		notified++
		if sandboxDBs != nil {
			if sdb, dbErr := sandboxDBs.Get(sb.ID); dbErr == nil {
				_ = sdb.LogEvent("restart_notice", map[string]string{
					"sandbox_id":       sb.ID,
					"notice_seconds":   fmt.Sprintf("%d", noticeSeconds),
					"restart_reason":   "worker_preemption",
					"preserves_disk":   "true",
					"preserves_memory": "false",
				})
			}
		}

		sandboxID := sb.ID
		wg.Add(1)
		go func() {
			defer wg.Done()
			execCtx, execCancel := context.WithTimeout(ctx, time.Duration(hookTimeout)*time.Second)
			defer execCancel()
			_, err := mgr.Exec(execCtx, sandboxID, types.ProcessConfig{
				Command: "/bin/sh",
				Args:    []string{"-lc", restartNoticeScript},
				Env: map[string]string{
					"OPENSANDBOX_RESUMABLE":             "true",
					"OPENSANDBOX_RESUME_NOTICE_SECONDS": fmt.Sprintf("%d", noticeSeconds),
				},
				Timeout: hookTimeout,
			})
			if err != nil {
				log.Printf("opensandbox-worker: resumable restart notice: hook failed for %s: %v", sandboxID, err)
			}
		}()
	}

	if notified == 0 {
		log.Printf("opensandbox-worker: resumable restart notice: no resumable sandboxes found")
		sleepContext(ctx, wait)
		return 0
	}
	log.Printf("opensandbox-worker: resumable restart notice: notifying %d sandboxes with %ds notice", notified, noticeSeconds)
	wg.Wait()

	remaining := wait - time.Since(started)
	if remaining > 0 {
		sleepContext(ctx, remaining)
	}
	log.Printf("opensandbox-worker: resumable restart notice: completed for %d sandboxes", notified)
	return notified
}

func isResumableSandboxSession(ctx context.Context, store *db.Store, sandboxID string) bool {
	if store == nil || sandboxID == "" {
		return false
	}
	sessionCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	session, err := store.GetSandboxSession(sessionCtx, sandboxID)
	if err != nil || session == nil {
		if err != nil {
			log.Printf("opensandbox-worker: resumable restart notice: failed to load sandbox session %s: %v", sandboxID, err)
		}
		return false
	}
	var cfg types.SandboxConfig
	if len(session.Config) > 0 {
		if err := json.Unmarshal(session.Config, &cfg); err != nil {
			log.Printf("opensandbox-worker: resumable restart notice: failed to parse config for %s: %v", sandboxID, err)
			return false
		}
	}
	return cfg.IsResumable()
}

func sleepContext(ctx context.Context, d time.Duration) {
	if d <= 0 {
		return
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
