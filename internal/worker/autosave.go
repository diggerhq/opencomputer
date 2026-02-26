package worker

import (
	"context"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	fc "github.com/opensandbox/opensandbox/internal/firecracker"
	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/internal/storage"
)

// WorkspaceAutosaver periodically backs up workspace drives to S3.
// On hard kill recovery, a sandbox can cold-boot from template + latest
// workspace backup (processes lost, but user files in /workspace are safe).
type WorkspaceAutosaver struct {
	manager         sandbox.Manager
	fcMgr           *fc.Manager
	checkpointStore *storage.CheckpointStore
	store           *db.Store
	workerID        string
	region          string
	interval        time.Duration
	concurrency     int
	stop            chan struct{}
	done            chan struct{}
}

// NewWorkspaceAutosaver creates a new autosaver.
func NewWorkspaceAutosaver(
	mgr sandbox.Manager,
	fcMgr *fc.Manager,
	checkpointStore *storage.CheckpointStore,
	store *db.Store,
	workerID string,
	region string,
	interval time.Duration,
) *WorkspaceAutosaver {
	return &WorkspaceAutosaver{
		manager:         mgr,
		fcMgr:           fcMgr,
		checkpointStore: checkpointStore,
		store:           store,
		workerID:        workerID,
		region:          region,
		interval:        interval,
		concurrency:     10,
		stop:            make(chan struct{}),
		done:            make(chan struct{}),
	}
}

// Start begins the periodic backup loop.
func (a *WorkspaceAutosaver) Start() {
	go a.loop()
	log.Printf("autosave: started (interval=%s, concurrency=%d)", a.interval, a.concurrency)
}

// Stop signals the loop to exit and waits for it to finish.
func (a *WorkspaceAutosaver) Stop() {
	close(a.stop)
	<-a.done
	log.Println("autosave: stopped")
}

func (a *WorkspaceAutosaver) loop() {
	defer close(a.done)
	ticker := time.NewTicker(a.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			a.backupAll()
		case <-a.stop:
			return
		}
	}
}

func (a *WorkspaceAutosaver) backupAll() {
	sandboxes, err := a.manager.List(context.Background())
	if err != nil {
		log.Printf("autosave: failed to list sandboxes: %v", err)
		return
	}
	if len(sandboxes) == 0 {
		return
	}

	log.Printf("autosave: backing up %d sandboxes", len(sandboxes))
	t0 := time.Now()

	sem := make(chan struct{}, a.concurrency)
	var wg sync.WaitGroup
	var successCount, failCount int32
	var mu sync.Mutex

	for _, sb := range sandboxes {
		select {
		case <-a.stop:
			log.Printf("autosave: interrupted, skipping remaining backups")
			break
		default:
		}

		wg.Add(1)
		sem <- struct{}{}
		go func(sandboxID string) {
			defer wg.Done()
			defer func() { <-sem }()

			if err := a.backupOne(sandboxID); err != nil {
				log.Printf("autosave: backup failed for %s: %v", sandboxID, err)
				mu.Lock()
				failCount++
				mu.Unlock()
			} else {
				mu.Lock()
				successCount++
				mu.Unlock()
			}
		}(sb.ID)
	}

	wg.Wait()
	log.Printf("autosave: completed in %dms (%d ok, %d failed)",
		time.Since(t0).Milliseconds(), successCount, failCount)
}

func (a *WorkspaceAutosaver) backupOne(sandboxID string) error {
	// 1. SyncFS — flush disk buffers (VM keeps running)
	syncCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := a.fcMgr.SyncFS(syncCtx, sandboxID); err != nil {
		return fmt.Errorf("syncfs: %w", err)
	}

	// 2. Get workspace path
	wsPath, err := a.fcMgr.GetWorkspacePath(sandboxID)
	if err != nil {
		return fmt.Errorf("workspace path: %w", err)
	}

	// Check file exists and get size
	info, err := os.Stat(wsPath)
	if err != nil {
		return fmt.Errorf("stat workspace: %w", err)
	}

	// 3. Upload workspace.ext4 directly to S3 (no archiving needed for workspace-only backup)
	backupKey := fmt.Sprintf("workspace-backups/%s/%d.ext4", sandboxID, time.Now().Unix())
	uploadCtx, uploadCancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer uploadCancel()

	if _, err := a.checkpointStore.Upload(uploadCtx, backupKey, wsPath); err != nil {
		return fmt.Errorf("s3 upload: %w", err)
	}

	// 4. Update DB with backup record
	if a.store != nil {
		session, err := a.store.GetSandboxSession(context.Background(), sandboxID)
		if err != nil {
			log.Printf("autosave: warning: no session for %s, skipping DB record: %v", sandboxID, err)
			return nil
		}
		if err := a.store.UpsertWorkspaceBackup(
			context.Background(),
			sandboxID,
			session.OrgID,
			backupKey,
			info.Size(),
			a.region,
			session.Template,
			session.Config,
		); err != nil {
			log.Printf("autosave: warning: failed to record backup for %s: %v", sandboxID, err)
		}
	}

	return nil
}
