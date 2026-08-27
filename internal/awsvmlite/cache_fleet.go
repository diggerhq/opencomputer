package awsvmlite

// The in-region voucher cache, from the control plane's side.
//
// What this manages: a small set of boxes, each running cmd/voucher-cache, that
// hold vouchers in RAM in us-east-1 so the edge can pop one in ~13ms instead of
// drawing from a Cloudflare colo cache that is non-atomic, per-colo and — the
// part that actually hurt — evictable. A colo that lost its book rebuilt it from
// here, in westus2, and burst TTI went from ~300ms to 1498ms.
//
// Three things this side is responsible for, and they are all consequences of
// where the cache lives rather than of what it does:
//
//   FILLING. The cache never restocks itself on a pop; if it did, a customer's
//   create would again be waiting on a control-plane round trip, which is the
//   coupling that caused the cliff. So stock arrives by push, on a timer.
//
//   KEEPING IT WARM. A box with no inbound proxy traffic suspends, and the
//   first request after that pays the restore. Measured against an idle box:
//   1305ms cold and repeated 190-450ms spikes, against 13ms p50 warm. The fill
//   tick is itself inbound proxy traffic, so filling frequently enough IS the
//   keepalive — there is deliberately no separate ping.
//
//   ROTATION. Boxes die at the 8h service cap. A replacement is stood up and
//   confirmed stocked BEFORE the incumbent is retired, so there is no moment
//   where the edge's only known instance is gone. The edge learns the new one
//   from the peer list it gets back on ordinary pops.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// CacheConfig configures the cache fleet. Zero Replicas disables it entirely.
type CacheConfig struct {
	// Enabled turns the fleet on. The service itself ships inside the guest
	// agent (internal/vouchercache), so there is nothing to install — a cache
	// instance is an ordinary box that the control plane happens to fill.
	Enabled bool
	// Replicas is how many stocked instances to keep. Two is the useful
	// minimum: rotation needs somewhere for traffic to go while a replacement
	// fills.
	Replicas int
	// Target is how many vouchers each instance should hold.
	Target int
	// FillInterval is both the restock period and the keepalive. Must stay
	// comfortably under the box's idle timeout.
	FillInterval time.Duration
	// MaxLifetime is when an instance is retired. Must be under the 8h AWS
	// service cap with enough room to stand up and stock a replacement.
	MaxLifetime time.Duration
	// Colo is the holder id vouchers are issued under. Not a real Cloudflare
	// colo — the cache serves every colo, which is the point.
	Colo string
}

func (c *CacheConfig) applyDefaults() {
	if c.Replicas == 0 {
		c.Replicas = 2
	}
	if c.Target == 0 {
		c.Target = 256
	}
	if c.FillInterval == 0 {
		c.FillInterval = 10 * time.Second
	}
	if c.MaxLifetime == 0 {
		// The cap is 8h. Leaving 45 minutes is enough for several launch
		// retries against the 5/s RunMicrovm quota without ever racing it.
		c.MaxLifetime = 7*time.Hour + 15*time.Minute
	}
	if c.Colo == "" {
		c.Colo = "region-cache"
	}
}

type cacheInstance struct {
	box       *Box
	startedAt time.Time
	ready     bool
	// fails counts consecutive fill failures. An instance that stops answering
	// is retired rather than left in the peer list, where the edge would keep
	// paying a timeout per create to discover it.
	fails int
}

// CacheFleet owns the cache instances. Safe for concurrent use.
type CacheFleet struct {
	m   *Manager
	cfg CacheConfig

	mu       sync.Mutex
	insts    []*cacheInstance
	inflight bool
}

func NewCacheFleet(m *Manager, cfg CacheConfig) *CacheFleet {
	cfg.applyDefaults()
	return &CacheFleet{m: m, cfg: cfg}
}

// maxFillFails is how many consecutive failures retire an instance. Small,
// because the fill tick is frequent and a healthy instance never misses.
const maxFillFails = 3

// Peers reports the currently stocked instances, newest deadline first.
//
// This is the edge's cold-start path only. In steady state the edge learns the
// set from pop responses and never asks the control plane at all — which is
// what keeps rotation off the create path.
func (f *CacheFleet) Peers() []CachePeer {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]CachePeer, 0, len(f.insts))
	for _, in := range f.insts {
		if !in.ready {
			continue
		}
		out = append(out, CachePeer{
			Endpoint:     in.box.Endpoint,
			Token:        in.box.Token,
			Port:         in.box.Port,
			RetireAtUnix: in.startedAt.Add(f.cfg.MaxLifetime).Unix(),
		})
	}
	return out
}

// CachePeer is one cache instance as the edge addresses it.
type CachePeer struct {
	Endpoint     string `json:"endpoint"`
	Token        string `json:"token"`
	Port         int32  `json:"port"`
	RetireAtUnix int64  `json:"retireAtUnix,omitempty"`
}

// Run drives the fleet until ctx is done.
func (f *CacheFleet) Run(ctx context.Context) {
	if !f.cfg.Enabled {
		log.Printf("awsvmlite/cache: disabled")
		return
	}
	log.Printf("awsvmlite/cache: starting (replicas=%d target=%d fill=%s lifetime=%s)",
		f.cfg.Replicas, f.cfg.Target, f.cfg.FillInterval, f.cfg.MaxLifetime)

	fill := time.NewTicker(f.cfg.FillInterval)
	defer fill.Stop()
	reconcile := time.NewTicker(30 * time.Second)
	defer reconcile.Stop()

	f.reconcile(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-fill.C:
			f.fillAll(ctx)
		case <-reconcile.C:
			f.reconcile(ctx)
		}
	}
}

// reconcile keeps Replicas young, stocked instances alive and retires aged ones.
//
// Order matters and is the whole of the rotation story: a replacement is
// launched while the incumbent is still serving, and the incumbent is only
// terminated once enough YOUNG instances are ready to take over. The fleet
// briefly runs at Replicas+1, which is the cost of never having a gap.
func (f *CacheFleet) reconcile(ctx context.Context) {
	now := time.Now()
	f.mu.Lock()
	young := 0
	for _, in := range f.insts {
		if in.ready && now.Sub(in.startedAt) < f.cfg.MaxLifetime {
			young++
		}
	}
	need := young < f.cfg.Replicas && !f.inflight
	if need {
		f.inflight = true
	}
	// Retire only what is genuinely surplus.
	var retire []*cacheInstance
	keep := f.insts[:0]
	for _, in := range f.insts {
		aged := now.Sub(in.startedAt) >= f.cfg.MaxLifetime
		broken := in.fails >= maxFillFails
		if (aged || broken) && young >= f.cfg.Replicas {
			retire = append(retire, in)
			continue
		}
		keep = append(keep, in)
	}
	f.insts = keep
	f.mu.Unlock()

	for _, in := range retire {
		log.Printf("awsvmlite/cache: retiring %s (age=%s fails=%d)",
			in.box.MicrovmID, now.Sub(in.startedAt).Truncate(time.Second), in.fails)
		go f.m.terminate(in.box.MicrovmID)
	}
	if need {
		go func() {
			defer func() {
				f.mu.Lock()
				f.inflight = false
				f.mu.Unlock()
			}()
			if err := f.launch(ctx); err != nil {
				log.Printf("awsvmlite/cache: launch failed: %v", err)
			}
		}()
	}
}

// launch stands up one cache instance and does not return until it is stocked.
//
// Readiness is depth-gated on the service side, so returning here means the
// instance can actually serve — publishing it earlier would put an instance
// that answers 204 into the peer list and silently push creates onto the slow
// path.
func (f *CacheFleet) launch(ctx context.Context) error {
	runCtx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()

	box, err := f.m.client.Run(runCtx, "")
	if err != nil {
		return fmt.Errorf("run: %w", err)
	}
	ready, err := f.m.client.WaitRunning(runCtx, box.ID, f.m.cfg.ReadyTimeout)
	if err != nil {
		go f.m.terminate(box.ID)
		return fmt.Errorf("wait running: %w", err)
	}
	token, err := f.m.client.AuthToken(runCtx, ready.ID)
	if err != nil {
		go f.m.terminate(ready.ID)
		return fmt.Errorf("auth token: %w", err)
	}
	b := &Box{
		MicrovmID: ready.ID,
		Endpoint:  ready.Endpoint,
		Token:     token,
		Port:      f.m.client.Config().AgentPort,
	}
	in := &cacheInstance{box: b, startedAt: time.Now()}
	// Stock it before anyone can see it.
	if err := f.fill(runCtx, in); err != nil {
		go f.m.terminate(ready.ID)
		return fmt.Errorf("first fill on %s: %w", ready.ID, err)
	}
	if !in.ready {
		go f.m.terminate(ready.ID)
		return fmt.Errorf("%s did not become ready after first fill", ready.ID)
	}

	f.mu.Lock()
	f.insts = append(f.insts, in)
	n := len(f.insts)
	f.mu.Unlock()
	log.Printf("awsvmlite/cache: instance %s READY (%d live)", b.MicrovmID, n)
	return nil
}

func (f *CacheFleet) fillAll(ctx context.Context) {
	f.mu.Lock()
	insts := append([]*cacheInstance(nil), f.insts...)
	f.mu.Unlock()
	for _, in := range insts {
		if err := f.fill(ctx, in); err != nil {
			log.Printf("awsvmlite/cache: fill %s failed (%d consecutive): %v", in.box.MicrovmID, in.fails, err)
		}
	}
}

// fill pushes the current promised set to one instance.
//
// It sends the WHOLE set every time, not a delta. The instance dedups by box
// id, and re-sending is what lets a replacement come up full — see
// ColoVouchers. A delta protocol would make the cache's memory authoritative,
// which it must never be: losing it has to stay a throughput event.
func (f *CacheFleet) fill(ctx context.Context, in *cacheInstance) error {
	vouchers := f.m.ColoVouchers(f.cfg.Colo, f.cfg.Target)
	peers := f.Peers()
	// A launching instance is not in Peers() yet; include it so the very first
	// pop already advertises the right set.
	self := CachePeer{
		Endpoint:     in.box.Endpoint,
		Token:        in.box.Token,
		Port:         in.box.Port,
		RetireAtUnix: in.startedAt.Add(f.cfg.MaxLifetime).Unix(),
	}
	found := false
	for _, p := range peers {
		if p.Endpoint == self.Endpoint {
			found = true
			break
		}
	}
	if !found {
		peers = append(peers, self)
	}

	body, err := json.Marshal(map[string]any{
		"vouchers": vouchers,
		"peers":    peers,
		"target":   f.cfg.Target,
	})
	if err != nil {
		return err
	}

	reqCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	resp, err := f.doCache(reqCtx, in.box, http.MethodPost, "fill", body)
	if err != nil {
		in.fails++
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		in.fails++
		return fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out struct {
		Depth int `json:"depth"`
		Added int `json:"added"`
	}
	_ = json.Unmarshal(raw, &out)
	in.fails = 0
	// Ready once it holds a workable share of target — mirrors the service's
	// own gate so this side does not publish an instance the service would
	// still 503.
	if !in.ready && out.Depth*2 >= f.cfg.Target && out.Depth > 0 {
		in.ready = true
	}
	return nil
}

// cachePath is where the guest agent mounts the cache. It shares the agent's
// listener because the proxy forwards only to the declared port.
const cachePath = "/osb/cache/"

func (f *CacheFleet) doCache(ctx context.Context, b *Box, method, path string, body []byte) (*http.Response, error) {
	return f.m.do(ctx, b, method, cachePath+path, body)
}
