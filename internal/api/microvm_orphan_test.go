package api

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	lambdamicrovms "github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
	mvtypes "github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"

	"github.com/opensandbox/opensandbox/internal/awsvm"
)

// sweepAPI serves a fixed inventory to the orphan sweep and records every
// termination it attempts. Only the calls the sweep makes are implemented.
type sweepAPI struct {
	items      []mvtypes.MicrovmItem
	getImage   map[string]string // id → ImageArn returned by GetMicrovm
	getState   map[string]mvtypes.MicrovmState
	terminated []string
	gets       int
}

func (f *sweepAPI) ListMicrovms(context.Context, *lambdamicrovms.ListMicrovmsInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.ListMicrovmsOutput, error) {
	return &lambdamicrovms.ListMicrovmsOutput{Items: f.items}, nil
}
func (f *sweepAPI) GetMicrovm(_ context.Context, in *lambdamicrovms.GetMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.GetMicrovmOutput, error) {
	f.gets++
	id := aws.ToString(in.MicrovmIdentifier)
	state := mvtypes.MicrovmStateRunning
	if s, ok := f.getState[id]; ok {
		state = s
	}
	return &lambdamicrovms.GetMicrovmOutput{
		MicrovmId: aws.String(id),
		ImageArn:  aws.String(f.getImage[id]),
		State:     state,
	}, nil
}
func (f *sweepAPI) TerminateMicrovm(_ context.Context, in *lambdamicrovms.TerminateMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.TerminateMicrovmOutput, error) {
	f.terminated = append(f.terminated, aws.ToString(in.MicrovmIdentifier))
	return &lambdamicrovms.TerminateMicrovmOutput{}, nil
}
func (f *sweepAPI) RunMicrovm(context.Context, *lambdamicrovms.RunMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.RunMicrovmOutput, error) {
	panic("sweep must not launch")
}
func (f *sweepAPI) SuspendMicrovm(context.Context, *lambdamicrovms.SuspendMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.SuspendMicrovmOutput, error) {
	panic("sweep must not suspend")
}
func (f *sweepAPI) ResumeMicrovm(context.Context, *lambdamicrovms.ResumeMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.ResumeMicrovmOutput, error) {
	panic("sweep must not resume")
}
func (f *sweepAPI) CreateMicrovmAuthToken(context.Context, *lambdamicrovms.CreateMicrovmAuthTokenInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.CreateMicrovmAuthTokenOutput, error) {
	panic("sweep must not mint tokens")
}

func summary(id, image string, age time.Duration) mvtypes.MicrovmItem {
	return mvtypes.MicrovmItem{
		MicrovmId: aws.String(id),
		ImageArn:  aws.String(image),
		State:     mvtypes.MicrovmStateRunning,
		StartedAt: aws.Time(time.Now().Add(-age)),
	}
}

func sweepBackend(t *testing.T, f *sweepAPI) *microvmBackend {
	t.Helper()
	const ourImage = "arn:ours"
	c := awsvm.NewClientWithAPI(f, awsvm.Config{ImageIdentifier: ourImage})
	return &microvmBackend{
		client:  c,
		pool:    awsvm.NewPool(c, awsvm.PoolConfig{}),
		manager: awsvm.NewManager(c, os.TempDir()),
	}
}

// This AWS account is shared with other products. The image check is the only
// thing standing between the sweep and someone else's fleet, so it must require
// a POSITIVE match — an unknown image has to protect a box, not expose it.
//
// The original guard read `ImageArn != "" && ImageArn != ourImage`, which skipped
// the comparison entirely when the field was empty. ListMicrovms returns a
// reduced projection, so "empty" is a routine answer, not a rare one — that
// version would have terminated every foreign box whose image it failed to read.
func TestOrphanSweepNeverReapsWhatItCannotProveIsOurs(t *testing.T) {
	t.Setenv("OPENSANDBOX_MICROVM_ORPHAN_REAP", "1")
	old := 2 * orphanMinAge

	f := &sweepAPI{
		items: []mvtypes.MicrovmItem{
			summary("microvm-ours", "arn:ours", old),
			summary("microvm-theirs", "arn:someone-else", old),
			summary("microvm-blank", "", old),  // list omitted it; Get says foreign
			summary("microvm-hidden", "", old), // list omitted it; Get says ours
		},
		getImage: map[string]string{
			"microvm-blank":  "arn:someone-else",
			"microvm-hidden": "arn:ours",
		},
	}
	b := sweepBackend(t, f)
	b.sweepOrphans(context.Background())

	got := map[string]bool{}
	for _, id := range f.terminated {
		got[id] = true
	}
	if !got["microvm-ours"] {
		t.Error("did not reap microvm-ours — an abandoned box of ours keeps holding quota")
	}
	if !got["microvm-hidden"] {
		t.Error("did not reap microvm-hidden — a Get proved it ours, so the list projection gap should not shield it")
	}
	if got["microvm-theirs"] {
		t.Fatal("TERMINATED ANOTHER PRODUCT'S BOX (microvm-theirs) — foreign image was reaped")
	}
	if got["microvm-blank"] {
		t.Fatal("TERMINATED ANOTHER PRODUCT'S BOX (microvm-blank) — empty list image fell through the guard")
	}
}

// If the image cannot be established at all, nothing is eligible. A sweep that
// reaps on ignorance is worse than one that reaps nothing.
func TestOrphanSweepReapsNothingWhenOwnershipIsUnknowable(t *testing.T) {
	t.Setenv("OPENSANDBOX_MICROVM_ORPHAN_REAP", "1")
	old := 2 * orphanMinAge

	f := &sweepAPI{
		items: []mvtypes.MicrovmItem{
			summary("microvm-a", "", old),
			summary("microvm-b", "", old),
		},
		getImage: map[string]string{}, // Get returns "" too
	}
	b := sweepBackend(t, f)
	b.sweepOrphans(context.Background())

	if len(f.terminated) != 0 {
		t.Fatalf("terminated %v with no provable ownership", f.terminated)
	}
}

// Young boxes must be skipped before the image lookup, or a large foreign fleet
// costs a GetMicrovm each on an account that already throttles ListMicrovms.
func TestOrphanSweepDoesNotProbeYoungBoxes(t *testing.T) {
	f := &sweepAPI{
		items: []mvtypes.MicrovmItem{
			summary("microvm-young", "", time.Minute),
		},
	}
	b := sweepBackend(t, f)
	b.sweepOrphans(context.Background())

	if f.gets != 0 {
		t.Fatalf("issued %d GetMicrovm call(s) for a box too young to reap", f.gets)
	}
}
