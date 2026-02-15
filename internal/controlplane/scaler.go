package controlplane

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/opensandbox/opensandbox/internal/compute"
)

const (
	scaleUpThreshold   = 0.70 // Scale up when utilization > 70%
	scaleDownThreshold = 0.30 // Scale down when utilization < 30%
	minWorkersPerRegion = 1
	scaleCheckInterval = 10 * time.Second
)

// Scaler manages autoscaling of workers via the compute Pool.
type Scaler struct {
	pool     compute.Pool
	registry *WorkerRegistry
	image    string // worker Docker image
	stop     chan struct{}
	wg       sync.WaitGroup
}

// NewScaler creates a new autoscaling controller.
func NewScaler(pool compute.Pool, registry *WorkerRegistry, workerImage string) *Scaler {
	return &Scaler{
		pool:     pool,
		registry: registry,
		image:    workerImage,
		stop:     make(chan struct{}),
	}
}

// Start begins the autoscaling loop.
func (s *Scaler) Start() {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ticker := time.NewTicker(scaleCheckInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				s.evaluate()
			case <-s.stop:
				return
			}
		}
	}()
	log.Println("scaler: autoscaling controller started")
}

// Stop stops the autoscaling loop.
func (s *Scaler) Stop() {
	close(s.stop)
	s.wg.Wait()
}

func (s *Scaler) evaluate() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	regions := s.registry.Regions()
	for _, region := range regions {
		s.evaluateRegion(ctx, region)
	}
}

func (s *Scaler) evaluateRegion(ctx context.Context, region string) {
	workers := s.registry.GetWorkersByRegion(region)
	utilization := s.registry.RegionUtilization(region)

	if utilization > scaleUpThreshold {
		log.Printf("scaler: region %s utilization %.1f%% > %.0f%%, scaling up", region, utilization*100, scaleUpThreshold*100)
		s.scaleUp(ctx, region)
	} else if utilization < scaleDownThreshold && len(workers) > minWorkersPerRegion {
		log.Printf("scaler: region %s utilization %.1f%% < %.0f%%, scaling down", region, utilization*100, scaleDownThreshold*100)
		s.scaleDown(ctx, region, workers)
	}
}

func (s *Scaler) scaleUp(ctx context.Context, region string) {
	opts := compute.MachineOpts{
		Region: region,
		Image:  s.image,
	}

	machine, err := s.pool.CreateMachine(ctx, opts)
	if err != nil {
		log.Printf("scaler: failed to create machine in %s: %v", region, err)
		return
	}

	log.Printf("scaler: created machine %s in %s (addr=%s)", machine.ID, region, machine.Addr)
}

func (s *Scaler) scaleDown(ctx context.Context, region string, workers []*WorkerInfo) {
	// Find the least-loaded worker to drain
	var target *WorkerInfo
	for _, w := range workers {
		if target == nil || w.Current < target.Current {
			target = w
		}
	}

	if target == nil {
		return
	}

	log.Printf("scaler: draining worker %s in %s (current=%d)", target.ID, region, target.Current)

	if err := s.pool.DrainMachine(ctx, target.ID); err != nil {
		log.Printf("scaler: failed to drain machine %s: %v", target.ID, err)
		return
	}

	if err := s.pool.DestroyMachine(ctx, target.ID); err != nil {
		log.Printf("scaler: failed to destroy machine %s: %v", target.ID, err)
	}
}
