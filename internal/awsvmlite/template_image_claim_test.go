package awsvmlite

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
	"github.com/opensandbox/opensandbox/internal/awsvm"
)

// recordingAPI captures which image each RunMicrovm asked for. That is the
// whole question this file answers: a template create must launch the
// TEMPLATE's image, and must not be served a pooled box built from the default
// image — a substitution the customer cannot detect until their packages turn
// out to be missing.
type recordingAPI struct {
	mu     sync.Mutex
	images []string
}

func (f *recordingAPI) RunMicrovm(_ context.Context, in *lambdamicrovms.RunMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.RunMicrovmOutput, error) {
	f.mu.Lock()
	f.images = append(f.images, aws.ToString(in.ImageIdentifier))
	f.mu.Unlock()
	return &lambdamicrovms.RunMicrovmOutput{
		MicrovmId: aws.String("microvm-test"),
		Endpoint:  aws.String("test.lambda-microvm.us-east-1.on.aws"),
		State:     types.MicrovmStateRunning,
	}, nil
}

func (f *recordingAPI) GetMicrovm(_ context.Context, _ *lambdamicrovms.GetMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.GetMicrovmOutput, error) {
	return &lambdamicrovms.GetMicrovmOutput{
		MicrovmId: aws.String("microvm-test"),
		Endpoint:  aws.String("test.lambda-microvm.us-east-1.on.aws"),
		State:     types.MicrovmStateRunning,
	}, nil
}

func (f *recordingAPI) CreateMicrovmAuthToken(_ context.Context, _ *lambdamicrovms.CreateMicrovmAuthTokenInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.CreateMicrovmAuthTokenOutput, error) {
	return &lambdamicrovms.CreateMicrovmAuthTokenOutput{AuthToken: map[string]string{"X-aws-proxy-auth": "tok"}}, nil
}

func (f *recordingAPI) SuspendMicrovm(context.Context, *lambdamicrovms.SuspendMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.SuspendMicrovmOutput, error) {
	return &lambdamicrovms.SuspendMicrovmOutput{}, nil
}
func (f *recordingAPI) ResumeMicrovm(context.Context, *lambdamicrovms.ResumeMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.ResumeMicrovmOutput, error) {
	return &lambdamicrovms.ResumeMicrovmOutput{}, nil
}
func (f *recordingAPI) TerminateMicrovm(context.Context, *lambdamicrovms.TerminateMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.TerminateMicrovmOutput, error) {
	return &lambdamicrovms.TerminateMicrovmOutput{}, nil
}
func (f *recordingAPI) ListMicrovms(context.Context, *lambdamicrovms.ListMicrovmsInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.ListMicrovmsOutput, error) {
	return &lambdamicrovms.ListMicrovmsOutput{}, nil
}

func (f *recordingAPI) launched() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.images...)
}

const (
	defaultImg  = "arn:aws:lambda:us-east-1:1:microvm-image:pool-default"
	templateImg = "arn:aws:lambda:us-east-1:1:microvm-image:osb-tpl-abc123"
)

func newRecordingManager(t *testing.T) (*Manager, *recordingAPI) {
	t.Helper()
	api := &recordingAPI{}
	client := awsvm.NewClientWithAPI(api, awsvm.Config{
		ImageIdentifier: defaultImg,
		DefaultMemoryMB: 4096,
	})
	return New(client, Config{}), api
}

// THE test for CT-4: a template-image claim must call RunMicrovm with the
// TEMPLATE's ARN, and must report warm=false so no pooled box is handed over.
func TestClaimLaunchesTheTemplateImageNotTheDefault(t *testing.T) {
	m, api := newRecordingManager(t)

	box, warm, err := m.Claim(context.Background(), "sb-tpl", Meta{
		MemoryMB:         4096,
		TemplateImageARN: templateImg,
	})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if warm {
		t.Error("a template claim reported warm=true — it was served from the pool, which holds DEFAULT-image boxes")
	}
	got := api.launched()
	if len(got) != 1 {
		t.Fatalf("expected exactly one launch, got %v", got)
	}
	if got[0] != templateImg {
		t.Errorf("launched %q, want the template image %q", got[0], templateImg)
	}
	if box == nil || box.Meta.TemplateImageARN != templateImg {
		t.Error("the bound box does not carry the template ARN, so Activate's cross-check cannot verify it")
	}
	// Metered at the default tier rather than 0 — a zero would bill the
	// sandbox as free.
	if box.Meta.MemoryMB != 4096 {
		t.Errorf("template box metered at %d MB, want the default tier", box.Meta.MemoryMB)
	}
}

// The inverse, and the reason the field must be empty for ordinary creates: a
// plain request must NOT take the template path, or every create cold-launches.
func TestPlainClaimDoesNotTakeTheTemplatePath(t *testing.T) {
	m, api := newRecordingManager(t)
	if _, _, err := m.Claim(context.Background(), "sb-plain", Meta{MemoryMB: 4096}); err != nil {
		t.Fatalf("claim: %v", err)
	}
	for _, img := range api.launched() {
		if strings.Contains(img, "osb-tpl-") {
			t.Errorf("a plain create launched a template image: %s", img)
		}
	}
}
