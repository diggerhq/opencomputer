package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
)

// AdminEvent represents a real-time event for the admin dashboard.
type AdminEvent struct {
	Time    string `json:"time"`
	Type    string `json:"type"`    // "create", "destroy", "scale", "migrate", "error", "scaler"
	Sandbox string `json:"sandbox"` // sandbox ID
	Worker  string `json:"worker"`  // worker ID
	Detail  string `json:"detail"`  // human-readable detail
}

// AdminEventBus broadcasts events to connected SSE clients.
type AdminEventBus struct {
	mu       sync.RWMutex
	clients  map[chan AdminEvent]struct{}
	history  []AdminEvent // last 200 events
}

// NewAdminEventBus creates a new event bus.
func NewAdminEventBus() *AdminEventBus {
	return &AdminEventBus{
		clients: make(map[chan AdminEvent]struct{}),
	}
}

// Publish sends an event to all connected clients and stores in history.
func (b *AdminEventBus) Publish(eventType, sandboxID, workerID, detail string) {
	evt := AdminEvent{
		Time:    time.Now().Format("15:04:05"),
		Type:    eventType,
		Sandbox: sandboxID,
		Worker:  workerID,
		Detail:  detail,
	}

	b.mu.Lock()
	b.history = append(b.history, evt)
	if len(b.history) > 2000 {
		b.history = b.history[len(b.history)-2000:]
	}
	// Copy clients under lock
	clients := make([]chan AdminEvent, 0, len(b.clients))
	for ch := range b.clients {
		clients = append(clients, ch)
	}
	b.mu.Unlock()

	// Send non-blocking to each client
	for _, ch := range clients {
		select {
		case ch <- evt:
		default:
			// Client too slow, skip
		}
	}
}

// subscribe returns a channel that receives events and a cleanup function.
func (b *AdminEventBus) subscribe() (chan AdminEvent, func()) {
	ch := make(chan AdminEvent, 50)
	b.mu.Lock()
	b.clients[ch] = struct{}{}
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		delete(b.clients, ch)
		b.mu.Unlock()
		close(ch)
	}
}

// History returns the last N events.
func (b *AdminEventBus) History() []AdminEvent {
	b.mu.RLock()
	defer b.mu.RUnlock()
	result := make([]AdminEvent, len(b.history))
	copy(result, b.history)
	return result
}

// adminEventsSSE streams events to the admin dashboard via Server-Sent Events.
func (s *Server) adminEventsSSE(c echo.Context) error {
	if s.adminEvents == nil {
		return c.String(http.StatusServiceUnavailable, "event bus not initialized")
	}

	c.Response().Header().Set("Content-Type", "text/event-stream")
	c.Response().Header().Set("Cache-Control", "no-cache")
	c.Response().Header().Set("Connection", "keep-alive")
	c.Response().WriteHeader(http.StatusOK)
	c.Response().Flush()

	// Send history first
	for _, evt := range s.adminEvents.History() {
		data, _ := json.Marshal(evt)
		fmt.Fprintf(c.Response(), "data: %s\n\n", data)
	}
	c.Response().Flush()

	// Subscribe to new events
	ch, cleanup := s.adminEvents.subscribe()
	defer cleanup()

	for {
		select {
		case evt, ok := <-ch:
			if !ok {
				return nil
			}
			data, _ := json.Marshal(evt)
			fmt.Fprintf(c.Response(), "data: %s\n\n", data)
			c.Response().Flush()
		case <-c.Request().Context().Done():
			return nil
		}
	}
}

// adminEventsHistory returns recent events as JSON (for initial page load).
func (s *Server) adminEventsHistory(c echo.Context) error {
	if s.adminEvents == nil {
		return c.JSON(http.StatusOK, []AdminEvent{})
	}
	return c.JSON(http.StatusOK, s.adminEvents.History())
}

// adminClearEvents clears the event history.
func (s *Server) adminClearEvents(c echo.Context) error {
	if s.adminEvents != nil {
		s.adminEvents.mu.Lock()
		s.adminEvents.history = nil
		s.adminEvents.mu.Unlock()
	}
	return c.JSON(http.StatusOK, map[string]string{"status": "cleared"})
}

// emitEvent publishes an event to the admin dashboard if the event bus is initialized.
func (s *Server) emitEvent(eventType, sandboxID, workerID, detail string) {
	if s.adminEvents != nil {
		s.adminEvents.Publish(eventType, sandboxID, workerID, detail)
	}
}

// adminReport generates a summary report from the event history.
func (s *Server) adminReport(c echo.Context) error {
	if s.adminEvents == nil {
		return c.JSON(http.StatusOK, map[string]string{"error": "no events"})
	}
	events := s.adminEvents.History()

	creates := 0
	destroys := 0
	scales := 0
	scaleFails := 0
	migrations := 0
	migrationDetails := []map[string]string{}
	errors := 0

	for _, e := range events {
		switch e.Type {
		case "create":
			creates++
		case "destroy":
			destroys++
		case "scale":
			scales++
		case "migrate":
			migrations++
			migrationDetails = append(migrationDetails, map[string]string{
				"time":    e.Time,
				"sandbox": e.Sandbox,
				"worker":  e.Worker,
				"detail":  e.Detail,
			})
		case "error":
			errors++
			if strings.Contains(e.Detail, "scale") {
				scaleFails++
			}
		}
	}

	// Get current worker state
	workers := []map[string]interface{}{}
	if s.workerRegistry != nil {
		for _, w := range s.workerRegistry.GetAllWorkers() {
			workers = append(workers, map[string]interface{}{
				"id":       w.ID[len(w.ID)-8:],
				"current":  w.Current,
				"cpu_pct":  w.CPUPct,
				"mem_pct":  w.MemPct,
				"disk_pct": w.DiskPct,
			})
		}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"total_events": len(events),
		"creates":      creates,
		"destroys":     destroys,
		"scales":       scales,
		"scale_fails":  scaleFails,
		"migrations": map[string]interface{}{
			"total":     migrations,
			"succeeded": migrations, // all logged migrations are successes (failures logged as errors)
			"details":   migrationDetails,
		},
		"errors":  errors,
		"workers": workers,
	})
}
