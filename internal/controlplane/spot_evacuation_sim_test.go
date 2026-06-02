package controlplane

import (
	"math"
	"testing"
	"time"
)

type spotEvacuationScenario struct {
	name          string
	sourceSlots   int
	sourceUsedPct int
	spareSlots    int
	spareUsed     int
	migrationP95  time.Duration
	noticeWindow  time.Duration
}

type spotEvacuationResult struct {
	workloads      int
	spareAvailable int
	moved          int
	remaining      int
	waves          int
	duration       time.Duration
}

func simulateSpotEvacuation(sc spotEvacuationScenario) spotEvacuationResult {
	workloads := sc.sourceSlots * sc.sourceUsedPct / 100
	spareAvailable := sc.spareSlots - sc.spareUsed
	if spareAvailable < 0 {
		spareAvailable = 0
	}

	moved := workloads
	if moved > spareAvailable {
		moved = spareAvailable
	}
	remaining := workloads - moved
	waves := int(math.Ceil(float64(moved) / float64(evacuationBatchSize)))

	var duration time.Duration
	if waves > 0 {
		duration = time.Duration(waves)*sc.migrationP95 + time.Duration(waves-1)*drainBatchSuccessPause
	}

	return spotEvacuationResult{
		workloads:      workloads,
		spareAvailable: spareAvailable,
		moved:          moved,
		remaining:      remaining,
		waves:          waves,
		duration:       duration,
	}
}

func TestSpotEvacuationScenariosWithOneSpareWorker(t *testing.T) {
	const (
		sourceSlots = 100
		spareSlots  = 100
	)

	cases := []struct {
		sc               spotEvacuationScenario
		wantWithinNotice bool
	}{
		{
			sc: spotEvacuationScenario{
				name:          "source 25 percent full",
				sourceSlots:   sourceSlots,
				sourceUsedPct: 25,
				spareSlots:    spareSlots,
				migrationP95:  5 * time.Second,
				noticeWindow:  2 * time.Minute,
			},
			wantWithinNotice: true,
		},
		{
			sc: spotEvacuationScenario{
				name:          "source 50 percent full",
				sourceSlots:   sourceSlots,
				sourceUsedPct: 50,
				spareSlots:    spareSlots,
				migrationP95:  5 * time.Second,
				noticeWindow:  2 * time.Minute,
			},
			wantWithinNotice: true,
		},
		{
			sc: spotEvacuationScenario{
				name:          "source 75 percent full",
				sourceSlots:   sourceSlots,
				sourceUsedPct: 75,
				spareSlots:    spareSlots,
				migrationP95:  5 * time.Second,
				noticeWindow:  2 * time.Minute,
			},
			wantWithinNotice: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.sc.name, func(t *testing.T) {
			got := simulateSpotEvacuation(tc.sc)

			if got.remaining != 0 {
				t.Fatalf("expected spare worker to fit all workloads, moved=%d remaining=%d", got.moved, got.remaining)
			}

			withinNotice := got.duration <= tc.sc.noticeWindow
			if withinNotice != tc.wantWithinNotice {
				t.Fatalf("duration=%s waves=%d workloads=%d, within notice=%v want %v",
					got.duration, got.waves, got.workloads, withinNotice, tc.wantWithinNotice)
			}

			t.Logf("%s: workloads=%d waves=%d estimated=%s notice=%s",
				tc.sc.name, got.workloads, got.waves, got.duration, tc.sc.noticeWindow)
		})
	}
}

func TestSpotEvacuationRequiresEnoughSpareCapacity(t *testing.T) {
	sc := spotEvacuationScenario{
		name:          "50 percent source, half-used spare",
		sourceSlots:   100,
		sourceUsedPct: 50,
		spareSlots:    80,
		spareUsed:     40,
		migrationP95:  5 * time.Second,
		noticeWindow:  2 * time.Minute,
	}

	got := simulateSpotEvacuation(sc)

	if got.spareAvailable != 40 {
		t.Fatalf("expected 40 spare slots, got %d", got.spareAvailable)
	}
	if got.moved != 40 || got.remaining != 10 {
		t.Fatalf("expected partial evacuation: moved=40 remaining=10, got moved=%d remaining=%d", got.moved, got.remaining)
	}
}
