package awsvm

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
	mvtypes "github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// imageSpyAPI records which image each RunMicrovm asked for. Sizing is a
// property of the image here, so "did we launch the right image" IS "did the
// customer get the size they paid for" — there is nothing else to assert on.
type imageSpyAPI struct {
	API
	mu     sync.Mutex
	images []string
	n      int
}

func (f *imageSpyAPI) RunMicrovm(_ context.Context, in *lambdamicrovms.RunMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.RunMicrovmOutput, error) {
	f.mu.Lock()
	f.n++
	id := "mvm-" + string(rune('a'+f.n-1))
	f.images = append(f.images, aws.ToString(in.ImageIdentifier))
	f.mu.Unlock()
	return &lambdamicrovms.RunMicrovmOutput{
		MicrovmId: aws.String(id),
		Endpoint:  aws.String(id + ".microvm.aws.dev"),
	}, nil
}

func (f *imageSpyAPI) GetMicrovm(_ context.Context, in *lambdamicrovms.GetMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.GetMicrovmOutput, error) {
	id := aws.ToString(in.MicrovmIdentifier)
	return &lambdamicrovms.GetMicrovmOutput{
		MicrovmId: aws.String(id),
		Endpoint:  aws.String(id + ".microvm.aws.dev"),
		State:     mvtypes.MicrovmStateRunning,
	}, nil
}

func (f *imageSpyAPI) launched() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.images...)
}

func tieredManager(t *testing.T) (*Manager, *imageSpyAPI) {
	t.Helper()
	spy := &imageSpyAPI{}
	c := NewClientWithAPI(spy, Config{
		ImageIdentifier: "arn:default",
		DefaultMemoryMB: 4096,
		SizeImages:      map[int]string{8192: "arn:8gb"},
	})
	return NewManager(c, t.TempDir()), spy
}

// Create and Get must report the SAME size, and it must be the delivered one.
//
// Create used to echo cfg.MemoryMB/cfg.CpuCount straight back while Track
// recorded deliveredSize, so a create asking for 8 GB answered "8192" and an
// immediate Get on the same sandbox answered "2048". Whichever number a caller
// happened to read became what it believed.
func TestCreateReportsDeliveredSizeAndAgreesWithGet(t *testing.T) {
	m, _ := tieredManager(t)

	sb, err := m.Create(context.Background(), types.SandboxConfig{SandboxID: "sb-def"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if sb.MemoryMB != 4096 {
		t.Errorf("Create reported %dMB, want the delivered 4096", sb.MemoryMB)
	}
	got, err := m.Get(context.Background(), "sb-def")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.MemoryMB != sb.MemoryMB || got.CpuCount != sb.CpuCount {
		t.Errorf("Get says %dMB/%dcpu but Create said %dMB/%dcpu — the two must never disagree",
			got.MemoryMB, got.CpuCount, sb.MemoryMB, sb.CpuCount)
	}
}

// A configured tier must launch ITS image, not the default one.
func TestCreateLaunchesTheTierImage(t *testing.T) {
	m, spy := tieredManager(t)

	sb, err := m.Create(context.Background(), types.SandboxConfig{SandboxID: "sb-8g", MemoryMB: 8192})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if launched := spy.launched(); len(launched) != 1 || launched[0] != "arn:8gb" {
		t.Fatalf("launched %v, want [arn:8gb] — a tier served from the default image is a silent downsize", launched)
	}
	if sb.MemoryMB != 8192 {
		t.Errorf("Create reported %dMB for the 8 GB tier, want 8192", sb.MemoryMB)
	}
	if sb.CpuCount != 2 {
		t.Errorf("CpuCount=%d for the 8 GB tier, want 2 to match the published tier table", sb.CpuCount)
	}
}

// A tier with no image must be REFUSED, never quietly served from the default.
//
// This is the whole reason ImageForMemory returns a bool instead of defaulting:
// handing a 16 GB request a 4 GB box, and metering it at 4 GB, is a wrong-size
// delivery the customer has no way to detect.
func TestUnconfiguredTierIsRefusedNotDownsized(t *testing.T) {
	m, spy := tieredManager(t)

	_, err := m.Create(context.Background(), types.SandboxConfig{SandboxID: "sb-16g", MemoryMB: 16384})
	if err == nil {
		t.Fatal("Create succeeded for an unconfigured tier — that means a downsized box was handed out")
	}
	if !errors.Is(err, ErrUnsupported) {
		t.Errorf("Create returned %v, want ErrUnsupported so the API answers 501", err)
	}
	if launched := spy.launched(); len(launched) != 0 {
		t.Errorf("launched %v for a refused tier — nothing should have been started", launched)
	}
}

// Only the default tier may be served from warm stock. This is what stops the
// pool handing a big request a default-size box.
func TestOnlyTheDefaultTierIsPoolable(t *testing.T) {
	cfg := Config{ImageIdentifier: "arn:default", DefaultMemoryMB: 4096, SizeImages: map[int]string{8192: "arn:8gb"}}
	cfg.applyDefaults()

	if !cfg.IsDefaultTier(0) {
		t.Error("unspecified size must be poolable — it is what the default create asks for")
	}
	if !cfg.IsDefaultTier(4096) {
		t.Error("naming the default size explicitly must still be poolable")
	}
	if cfg.IsDefaultTier(8192) || cfg.IsDefaultTier(16384) {
		t.Error("a non-default tier must miss the pool — warm stock is all one image")
	}
}

// OwnedImages must cover every tier, or the orphan sweep treats tier boxes as
// another product's and never reclaims them.
func TestOwnedImagesCoversEveryTier(t *testing.T) {
	cfg := Config{ImageIdentifier: "arn:default", SizeImages: map[int]string{8192: "arn:8gb", 1024: "arn:1gb"}}
	owned := map[string]bool{}
	for _, arn := range cfg.OwnedImages() {
		owned[arn] = true
	}
	for _, want := range []string{"arn:default", "arn:8gb", "arn:1gb"} {
		if !owned[want] {
			t.Errorf("OwnedImages missing %s — orphans on that image would never be reclaimed", want)
		}
	}
}

// deliveredSize ignores the ask and reports what the resolved image provides.
func TestDeliveredSizeIgnoresTheRequest(t *testing.T) {
	for _, tc := range []struct {
		requestedMB, requestedCPU, deliveredMB, wantMB, wantCPU int
	}{
		{8192, 4, 4096, 4096, 1},    // asked above the tier it resolved to
		{512, 1, 4096, 4096, 1},     // asked below
		{0, 0, 4096, 4096, 1},       // unspecified
		{8192, 2, 8192, 8192, 2},    // the 8 GB tier, honoured
		{16384, 4, 16384, 16384, 4}, // the 16 GB tier, honoured
	} {
		mem, cpu := deliveredSize("sb-x", tc.requestedMB, tc.requestedCPU, tc.deliveredMB)
		if mem != tc.wantMB || cpu != tc.wantCPU {
			t.Errorf("deliveredSize(req %d/%d, delivered %d) = %d/%d; want %d/%d",
				tc.requestedMB, tc.requestedCPU, tc.deliveredMB, mem, cpu, tc.wantMB, tc.wantCPU)
		}
	}
}

// A Manager with no client must still bind, not panic: several callers build
// one for bookkeeping only and never talk to AWS.
func TestTrackToleratesAClientlessManager(t *testing.T) {
	m := NewManager(nil, t.TempDir())
	mem, cpu := m.Track("sb-nil", &Box{ID: "mvm-nil"}, types.SandboxConfig{})
	if mem != deliveredMicrovmMemoryMB || cpu != deliveredMicrovmCPUCount {
		t.Errorf("Track on a clientless Manager gave %d/%d, want the baseline %d/%d",
			mem, cpu, deliveredMicrovmMemoryMB, deliveredMicrovmCPUCount)
	}
}
