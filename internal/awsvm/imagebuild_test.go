package awsvm

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
)

type fakeImageAPI struct {
	created    *lambdamicrovms.CreateMicrovmImageInput
	states     []types.MicrovmImageState // consumed one per GetMicrovmImage call
	stateIdx   int
	failedVer  string
	reason     string
	deleted    []string
	noActive   bool
	noArtifact bool
}

func (f *fakeImageAPI) CreateMicrovmImage(_ context.Context, in *lambdamicrovms.CreateMicrovmImageInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.CreateMicrovmImageOutput, error) {
	f.created = in
	return &lambdamicrovms.CreateMicrovmImageOutput{ImageArn: aws.String("arn:aws:lambda:us-east-1:1:microvm-image:" + *in.Name)}, nil
}

// GetMicrovmImage serves TWO different callers: resolveBaseImage asks about the
// base image, and WaitForImage polls the template image being built. Keying on
// the identifier keeps the base lookup from consuming a state intended for the
// build poll — which otherwise leaves WaitForImage polling an empty state until
// its 30-minute deadline.
func (f *fakeImageAPI) GetMicrovmImage(_ context.Context, in *lambdamicrovms.GetMicrovmImageInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.GetMicrovmImageOutput, error) {
	out := &lambdamicrovms.GetMicrovmImageOutput{}
	if aws.ToString(in.ImageIdentifier) == "base-image" {
		if !f.noActive {
			out.LatestActiveImageVersion = aws.String("7")
		}
		return out, nil
	}
	if f.failedVer != "" {
		out.LatestFailedImageVersion = aws.String(f.failedVer)
	}
	if f.stateIdx < len(f.states) {
		out.State = f.states[f.stateIdx]
		f.stateIdx++
	} else if len(f.states) > 0 {
		out.State = f.states[len(f.states)-1]
	}
	return out, nil
}

func (f *fakeImageAPI) GetMicrovmImageVersion(_ context.Context, _ *lambdamicrovms.GetMicrovmImageVersionInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.GetMicrovmImageVersionOutput, error) {
	out := &lambdamicrovms.GetMicrovmImageVersionOutput{
		BaseImageArn: aws.String("arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1"),
		BuildRoleArn: aws.String("arn:aws:iam::1:role/build"),
	}
	if !f.noArtifact {
		out.CodeArtifact = &types.CodeArtifactMemberUri{Value: "s3://bucket/base.zip"}
	}
	return out, nil
}

func (f *fakeImageAPI) GetMicrovmImageBuild(_ context.Context, _ *lambdamicrovms.GetMicrovmImageBuildInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.GetMicrovmImageBuildOutput, error) {
	return &lambdamicrovms.GetMicrovmImageBuildOutput{StateReason: aws.String(f.reason)}, nil
}

func (f *fakeImageAPI) DeleteMicrovmImage(_ context.Context, in *lambdamicrovms.DeleteMicrovmImageInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.DeleteMicrovmImageOutput, error) {
	f.deleted = append(f.deleted, *in.ImageIdentifier)
	return &lambdamicrovms.DeleteMicrovmImageOutput{}, nil
}

type memStore struct {
	objects map[string][]byte
	put     map[string][]byte
}

func (m *memStore) Get(_ context.Context, uri string) ([]byte, error) {
	b, ok := m.objects[uri]
	if !ok {
		return nil, fmt.Errorf("no object %s", uri)
	}
	return b, nil
}
func (m *memStore) Put(_ context.Context, uri string, body []byte) error {
	if m.put == nil {
		m.put = map[string][]byte{}
	}
	m.put[uri] = body
	return nil
}

func baseArtifact(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func newTestClient(f *fakeImageAPI) *Client {
	c := NewClientWithAPI(nil, Config{ImageIdentifier: "base-image", DefaultMemoryMB: 4096})
	return c.WithImageAPI(f)
}

func unzip(t *testing.T, b []byte) map[string]string {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		var sb strings.Builder
		if _, err := sb.Write(mustReadAll(t, rc)); err != nil {
			t.Fatal(err)
		}
		rc.Close()
		out[f.Name] = sb.String()
	}
	return out
}

func mustReadAll(t *testing.T, rc interface{ Read([]byte) (int, error) }) []byte {
	t.Helper()
	var buf bytes.Buffer
	tmp := make([]byte, 512)
	for {
		n, err := rc.Read(tmp)
		buf.Write(tmp[:n])
		if err != nil {
			break
		}
	}
	return buf.Bytes()
}

// The agent binaries must be inherited from the base artifact byte-for-byte.
// If a template image ever ships a different agent than the pool image, the
// control plane is talking to a build it was not compiled against.
func TestTemplateArtifactInheritsAgentBinariesAndReplacesDockerfile(t *testing.T) {
	f := &fakeImageAPI{states: []types.MicrovmImageState{types.MicrovmImageStateCreated}}
	store := &memStore{objects: map[string][]byte{
		"s3://bucket/base.zip": baseArtifact(t, map[string]string{
			"Dockerfile":    "FROM base\nENTRYPOINT [\"/usr/local/bin/microvm-hooks\"]\n",
			"osb-agent":     "AGENT-BINARY",
			"microvm-hooks": "HOOKS-BINARY",
		}),
	}}
	c := newTestClient(f)

	arn, err := c.BuildTemplateImage(context.Background(), store, TemplateBuildInput{
		ImageName:    "osb-tpl-abc",
		Dockerfile:   "FROM base\nRUN dnf install -y ffmpeg\nENTRYPOINT [\"/usr/local/bin/microvm-hooks\"]\n",
		ContextFiles: map[string][]byte{"ctx/0/config.json": []byte(`{"k":1}`)},
		ArtifactURI:  "s3://bucket/templates/abc.zip",
		Tags:         map[string]string{"osb:org": "org-1"},
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if !strings.HasSuffix(arn, "osb-tpl-abc") {
		t.Errorf("unexpected ARN %q", arn)
	}

	got := unzip(t, store.put["s3://bucket/templates/abc.zip"])
	if got["osb-agent"] != "AGENT-BINARY" || got["microvm-hooks"] != "HOOKS-BINARY" {
		t.Error("agent binaries were not inherited verbatim from the base artifact")
	}
	if !strings.Contains(got["Dockerfile"], "dnf install -y ffmpeg") {
		t.Error("customer Dockerfile did not replace the base one")
	}
	if got["ctx/0/config.json"] != `{"k":1}` {
		t.Errorf("context file missing or wrong: %q", got["ctx/0/config.json"])
	}
}

// Build parameters are inherited from the pool image's ACTIVE version so a
// template cannot be built against a different base or role than the fleet.
func TestBuildParametersAreInheritedFromTheBaseImage(t *testing.T) {
	f := &fakeImageAPI{states: []types.MicrovmImageState{types.MicrovmImageStateCreated}}
	store := &memStore{objects: map[string][]byte{
		"s3://bucket/base.zip": baseArtifact(t, map[string]string{"Dockerfile": "FROM base\n"}),
	}}
	if _, err := newTestClient(f).BuildTemplateImage(context.Background(), store, TemplateBuildInput{
		ImageName: "t", Dockerfile: "FROM base\n", ArtifactURI: "s3://bucket/t.zip",
	}); err != nil {
		t.Fatalf("build: %v", err)
	}
	in := f.created
	if aws.ToString(in.BaseImageArn) != "arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1" {
		t.Errorf("base image ARN not inherited: %q", aws.ToString(in.BaseImageArn))
	}
	if aws.ToString(in.BuildRoleArn) != "arn:aws:iam::1:role/build" {
		t.Errorf("build role not inherited: %q", aws.ToString(in.BuildRoleArn))
	}
	if len(in.CpuConfigurations) != 1 || in.CpuConfigurations[0].Architecture != types.ArchitectureArm64 {
		t.Error("image must be pinned to ARM_64 — the only architecture Lambda MicroVMs accepts")
	}
	if len(in.Resources) != 1 || aws.ToInt32(in.Resources[0].MinimumMemoryInMiB) != 4096 {
		t.Errorf("memory floor should match the default tier, got %v", in.Resources)
	}
	if in.Hooks == nil || aws.ToInt32(in.Hooks.Port) != 8080 {
		t.Error("hooks must match publish.sh (port 8080)")
	}
}

// An opaque CREATE_FAILED is unactionable: the reason lives on the build record
// and the full output in CloudWatch. Both must reach the customer.
func TestFailedBuildSurfacesReasonAndLogGroup(t *testing.T) {
	f := &fakeImageAPI{
		states:    []types.MicrovmImageState{types.MicrovmImageStateCreateFailed},
		failedVer: "8",
		reason:    "No match for argument: build-essential",
	}
	store := &memStore{objects: map[string][]byte{
		"s3://bucket/base.zip": baseArtifact(t, map[string]string{"Dockerfile": "FROM base\n"}),
	}}
	_, err := newTestClient(f).BuildTemplateImage(context.Background(), store, TemplateBuildInput{
		ImageName: "osb-tpl-xyz", Dockerfile: "FROM base\n", ArtifactURI: "s3://bucket/x.zip",
	})
	if err == nil {
		t.Fatal("expected a build failure")
	}
	for _, want := range []string{"No match for argument", "/aws/lambda/microvms/osb-tpl-xyz", "CREATE_FAILED"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error missing %q: %v", want, err)
		}
	}
}

// A base artifact without a Dockerfile is not the artifact we think it is.
func TestRefusesBaseArtifactWithoutDockerfile(t *testing.T) {
	f := &fakeImageAPI{}
	store := &memStore{objects: map[string][]byte{
		"s3://bucket/base.zip": baseArtifact(t, map[string]string{"osb-agent": "X"}),
	}}
	_, err := newTestClient(f).BuildTemplateImage(context.Background(), store, TemplateBuildInput{
		ImageName: "t", Dockerfile: "FROM base\n", ArtifactURI: "s3://bucket/t.zip",
	})
	if err == nil || !strings.Contains(err.Error(), "no Dockerfile") {
		t.Fatalf("expected refusal, got %v", err)
	}
}

// A base image whose newest build failed still serves the pool from its last
// good version; templates must be built from that, not from nothing.
func TestRefusesWhenBaseImageHasNoActiveVersion(t *testing.T) {
	f := &fakeImageAPI{noActive: true}
	store := &memStore{objects: map[string][]byte{}}
	_, err := newTestClient(f).BuildTemplateImage(context.Background(), store, TemplateBuildInput{
		ImageName: "t", Dockerfile: "FROM base\n", ArtifactURI: "s3://bucket/t.zip",
	})
	if err == nil || !strings.Contains(err.Error(), "no active version") {
		t.Fatalf("expected refusal, got %v", err)
	}
}

// A cell with no image API configured must say so, not nil-panic.
func TestUnconfiguredImageAPIFailsClearly(t *testing.T) {
	c := NewClientWithAPI(nil, Config{ImageIdentifier: "base"})
	_, err := c.BuildTemplateImage(context.Background(), &memStore{}, TemplateBuildInput{})
	if err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("expected a clear configuration error, got %v", err)
	}
	if err := c.DeleteTemplateImage(context.Background(), "arn:x"); err == nil {
		t.Fatal("delete should also refuse without an image API")
	}
}

func TestDeleteTemplateImageUsesTheGivenARN(t *testing.T) {
	f := &fakeImageAPI{}
	if err := newTestClient(f).DeleteTemplateImage(context.Background(), "arn:aws:lambda:us-east-1:1:microvm-image:osb-tpl-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if len(f.deleted) != 1 || f.deleted[0] != "arn:aws:lambda:us-east-1:1:microvm-image:osb-tpl-1" {
		t.Errorf("unexpected deletions: %v", f.deleted)
	}
}
