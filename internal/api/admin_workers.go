package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/controlplane"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// adminSetWorkerDraining toggles the in-memory `Draining` flag on a worker so
// the placement filter (RedisWorkerRegistry.GetLeastLoadedWorker and
// findScaleMigrationTargets) stops routing new sandboxes to it. Existing
// sandboxes on the worker are unaffected.
//
// POST /admin/workers/:id/drain          — mark draining (default)
// POST /admin/workers/:id/drain?drain=false — clear draining
//
// The flag is per-controlplane-instance memory: call this on every active
// control plane to drain consistently across replicas. Heartbeats do not
// overwrite the flag.
func (s *Server) adminSetWorkerDraining(c echo.Context) error {
	if s.workerRegistry == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "worker registry not configured (combined/worker mode)",
		})
	}

	workerID := c.Param("id")
	if workerID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "worker id required"})
	}

	drain := c.QueryParam("drain") != "false"

	known := false
	for _, w := range s.workerRegistry.GetAllWorkers() {
		if w.ID == workerID {
			known = true
			break
		}
	}
	if !known {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "worker not registered"})
	}

	s.workerRegistry.SetDraining(workerID, drain)

	return c.JSON(http.StatusOK, map[string]any{
		"workerID": workerID,
		"draining": drain,
	})
}

// adminEvacuateWorker starts the scaler's live-migration drain loop for a
// worker. Unlike scaler scale-down, this does not terminate the machine after
// it becomes empty; it is an operator/test hook for spot evacuation drills.
//
// POST /admin/workers/:id/evacuate
func (s *Server) adminEvacuateWorker(c echo.Context) error {
	if s.workerEvacuator == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"error": "worker evacuator not configured",
		})
	}

	workerID := c.Param("id")
	if workerID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "worker id required"})
	}

	if err := s.workerEvacuator.EvacuateWorker(c.Request().Context(), workerID); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": err.Error()})
	}

	return c.JSON(http.StatusAccepted, map[string]any{
		"workerID":   workerID,
		"evacuating": true,
	})
}

type adminRecreateSandboxRequest struct {
	TargetWorkerID string `json:"targetWorkerId,omitempty"`
}

func (s *Server) adminRecreateSandbox(c echo.Context) error {
	if s.store == nil || s.workerRegistry == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "store and worker registry are required"})
	}
	sandboxID := c.Param("id")
	if sandboxID == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "sandbox id required"})
	}

	var req adminRecreateSandboxRequest
	_ = c.Bind(&req)

	session, err := s.store.GetSandboxSession(c.Request().Context(), sandboxID)
	if err != nil {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "sandbox not found"})
	}
	var cfg types.SandboxConfig
	if len(session.Config) > 0 {
		if err := json.Unmarshal(session.Config, &cfg); err != nil {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid sandbox config: " + err.Error()})
		}
	}
	if !cfg.IsResumable() {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "sandbox is not resumable"})
	}
	cfg.SandboxID = sandboxID

	target := s.findRecreateTarget(session.WorkerID, session.Region, req.TargetWorkerID)
	if target == nil {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "no eligible target worker"})
	}
	if target.HTTPAddr == "" {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "target worker has no HTTP address"})
	}

	body, _ := json.Marshal(map[string]any{
		"sandboxId": sandboxID,
		"config":    cfg,
	})
	url := strings.TrimRight(target.HTTPAddr, "/") + "/admin/resumable/recreate"
	httpReq, err := http.NewRequestWithContext(c.Request().Context(), http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
	httpReq.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		return c.JSON(http.StatusBadGateway, map[string]string{"error": "target worker recreate failed: " + err.Error()})
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var workerErr map[string]string
		_ = json.NewDecoder(resp.Body).Decode(&workerErr)
		msg := workerErr["error"]
		if msg == "" {
			msg = fmt.Sprintf("target worker returned HTTP %d", resp.StatusCode)
		}
		return c.JSON(http.StatusBadGateway, map[string]string{"error": msg})
	}
	var sb types.Sandbox
	if err := json.NewDecoder(resp.Body).Decode(&sb); err != nil {
		return c.JSON(http.StatusBadGateway, map[string]string{"error": "decode target worker response: " + err.Error()})
	}

	if err := s.store.UpdateSandboxSessionForRecreate(c.Request().Context(), sandboxID, target.ID); err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "update sandbox session: " + err.Error()})
	}
	if target.GoldenVersion != "" {
		_ = s.store.SetSandboxGoldenVersion(c.Request().Context(), sandboxID, target.GoldenVersion)
	}
	if s.sandboxAPIProxy != nil {
		s.sandboxAPIProxy.InvalidateRouteCache(sandboxID)
	}
	s.emitEvent("resumed", sandboxID, target.ID, "resumable recreate")

	return c.JSON(http.StatusOK, map[string]any{
		"sandboxID":      sandboxID,
		"previousWorker": session.WorkerID,
		"workerID":       target.ID,
		"status":         sb.Status,
	})
}

func (s *Server) findRecreateTarget(sourceWorkerID, region, targetWorkerID string) *controlplane.WorkerEntry {
	if targetWorkerID != "" {
		w := s.workerRegistry.GetWorker(targetWorkerID)
		if w == nil || w.Draining {
			return nil
		}
		return w
	}
	var best *controlplane.WorkerEntry
	bestScore := 1e18
	for _, w := range s.workerRegistry.GetAllWorkers() {
		if w == nil || w.ID == sourceWorkerID || w.Draining {
			continue
		}
		if region != "" && w.Region != region {
			continue
		}
		score := float64(w.Current)*1000 + w.CPUPct + w.MemPct + w.DiskPct
		if best == nil || score < bestScore {
			best = w
			bestScore = score
		}
	}
	return best
}
