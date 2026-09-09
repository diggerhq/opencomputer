package awsvm

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
)

// Building a custom-template image.
//
// This is the server-side equivalent of deploy/microvm/{build,publish}.sh, and
// deliberately mirrors their parameters — a template image that differs from
// the pool image in its hooks, architecture or memory floor is a box that
// behaves differently from every other box on the fleet.
//
// The customer's Dockerfile is compiled elsewhere (api.RenderMicrovmDockerfile);
// this takes the rendered text and turns it into an image ARN.

// ObjectStore is the subset of S3 this needs. An interface rather than the
// concrete client so the packaging logic is testable without AWS.
type ObjectStore interface {
	Get(ctx context.Context, uri string) ([]byte, error)
	Put(ctx context.Context, uri string, body []byte) error
}

// TemplateBuildInput describes one custom-template image build.
type TemplateBuildInput struct {
	// ImageName is the AWS-side resource name. Must be unique per template and
	// must be recognisably ours — see the naming note in Build.
	ImageName string
	// Dockerfile is the fully rendered image definition (base prologue +
	// customer layers + agent epilogue).
	Dockerfile string
	// ContextFiles are extra files the Dockerfile's COPY lines reference,
	// keyed by their path inside the build context.
	ContextFiles map[string][]byte
	// ArtifactURI is where the build context ZIP is uploaded, e.g.
	// s3://bucket/templates/<id>.zip.
	ArtifactURI string
	// Tags are applied to the image resource. Ownership lives here.
	Tags map[string]string
}

// BuildTemplateImage packages, creates and waits for a custom-template image,
// returning its ARN.
//
// The wait is inline because the caller is an asynchronous job that already
// owns a template row in 'processing'; a caller that wants to poll itself can
// use CreateTemplateImage + WaitForImage directly.
func (c *Client) BuildTemplateImage(ctx context.Context, store ObjectStore, in TemplateBuildInput) (string, error) {
	if err := c.checkImageAPI(); err != nil {
		return "", err
	}
	spec, err := c.resolveBaseImage(ctx)
	if err != nil {
		return "", err
	}
	if err := c.packageTemplateArtifact(ctx, store, in, spec.ArtifactURI); err != nil {
		return "", err
	}
	arn, err := c.createTemplateImage(ctx, in, spec)
	if err != nil {
		return "", err
	}
	if err := c.WaitForImage(ctx, arn, in.ImageName); err != nil {
		return "", err
	}
	return arn, nil
}

// packageTemplateArtifact builds the ZIP Lambda will run the Dockerfile from.
//
// The agent binaries are taken from the BASE image's own code artifact rather
// than compiled here. Two reasons, and the second is the important one:
//
//   - The control plane cannot cross-compile arm64 Go binaries at runtime, and
//     shipping a second copy alongside the server binary means two artifacts
//     that must be updated together.
//   - Reusing the base artifact makes the agent in a custom-template image
//     byte-identical to the agent in the pool image. Any other source lets the
//     two drift, and the failure mode is a template box whose agent does not
//     match the control plane that will talk to it.
func (c *Client) packageTemplateArtifact(ctx context.Context, store ObjectStore, in TemplateBuildInput, baseURI string) error {
	baseZip, err := store.Get(ctx, baseURI)
	if err != nil {
		return fmt.Errorf("read base artifact %s: %w", baseURI, err)
	}
	zr, err := zip.NewReader(bytes.NewReader(baseZip), int64(len(baseZip)))
	if err != nil {
		return fmt.Errorf("base artifact %s is not a zip: %w", baseURI, err)
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	// Copy every entry EXCEPT the Dockerfile, which the customer's template
	// replaces. Anything else in the base artifact (the binaries) carries over
	// untouched.
	var sawDockerfile bool
	for _, f := range zr.File {
		if f.Name == "Dockerfile" {
			sawDockerfile = true
			continue
		}
		if err := copyZipEntry(zw, f); err != nil {
			return err
		}
	}
	if !sawDockerfile {
		// The base artifact is supposed to be Dockerfile + binaries. If there
		// is no Dockerfile in it we are not looking at what we think we are,
		// and silently shipping the customer's Dockerfile alongside unknown
		// content is worse than refusing.
		return fmt.Errorf("base artifact %s contains no Dockerfile — refusing to derive a template from it", baseURI)
	}

	if err := writeZipFile(zw, "Dockerfile", []byte(in.Dockerfile)); err != nil {
		return err
	}
	for path, content := range in.ContextFiles {
		if err := writeZipFile(zw, path, content); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("finalize template artifact: %w", err)
	}
	return store.Put(ctx, in.ArtifactURI, buf.Bytes())
}

// baseImageSpec is everything a template build inherits from the pool image.
type baseImageSpec struct {
	ArtifactURI  string
	BaseImageArn string
	BuildRoleArn string
}

// resolveBaseImage reads the pool image's active version and takes its build
// parameters wholesale.
//
// Deriving rather than configuring is deliberate. These three values must match
// what the pool image was built with — a template built from a different base or
// a different artifact is a box that differs from the fleet in ways nothing
// checks — and a separate set of env vars is a second source of truth that goes
// stale silently the first time the pool image is rebuilt. Config overrides
// exist for the cell that genuinely needs to differ, but the default is
// "whatever the pool image says".
func (c *Client) resolveBaseImage(ctx context.Context) (baseImageSpec, error) {
	cfg := c.Config()
	if cfg.ImageIdentifier == "" {
		return baseImageSpec{}, fmt.Errorf("no base image configured — cannot derive a template build")
	}
	img, err := c.imageAPI.GetMicrovmImage(ctx, &lambdamicrovms.GetMicrovmImageInput{
		ImageIdentifier: aws.String(cfg.ImageIdentifier),
	})
	if err != nil {
		return baseImageSpec{}, fmt.Errorf("get base image %s: %w", cfg.ImageIdentifier, err)
	}
	// The ACTIVE version, not the latest: a base image whose newest build failed
	// still serves the pool from its last good version, and a template must be
	// built from what the fleet is actually running.
	if img.LatestActiveImageVersion == nil || *img.LatestActiveImageVersion == "" {
		return baseImageSpec{}, fmt.Errorf("base image %s has no active version to build from", cfg.ImageIdentifier)
	}
	ver, err := c.imageAPI.GetMicrovmImageVersion(ctx, &lambdamicrovms.GetMicrovmImageVersionInput{
		ImageIdentifier: aws.String(cfg.ImageIdentifier),
		ImageVersion:    img.LatestActiveImageVersion,
	})
	if err != nil {
		return baseImageSpec{}, fmt.Errorf("get base image %s version %s: %w",
			cfg.ImageIdentifier, *img.LatestActiveImageVersion, err)
	}
	uri, ok := ver.CodeArtifact.(*types.CodeArtifactMemberUri)
	if !ok || uri == nil || uri.Value == "" {
		return baseImageSpec{}, fmt.Errorf("base image %s version %s has no code artifact URI",
			cfg.ImageIdentifier, *img.LatestActiveImageVersion)
	}
	spec := baseImageSpec{
		ArtifactURI:  uri.Value,
		BaseImageArn: aws.ToString(ver.BaseImageArn),
		BuildRoleArn: aws.ToString(ver.BuildRoleArn),
	}
	if cfg.TemplateBaseImageArn != "" {
		spec.BaseImageArn = cfg.TemplateBaseImageArn
	}
	if cfg.TemplateBuildRoleArn != "" {
		spec.BuildRoleArn = cfg.TemplateBuildRoleArn
	}
	if spec.BaseImageArn == "" || spec.BuildRoleArn == "" {
		return baseImageSpec{}, fmt.Errorf("base image %s reports no base-image/build-role ARN and none is configured",
			cfg.ImageIdentifier)
	}
	return spec, nil
}

func (c *Client) createTemplateImage(ctx context.Context, in TemplateBuildInput, spec baseImageSpec) (string, error) {
	cfg := c.Config()
	mem := int32(cfg.DefaultMemoryMB)
	if mem <= 0 {
		mem = deliveredMicrovmMemoryMB
	}

	out, err := c.imageAPI.CreateMicrovmImage(ctx, &lambdamicrovms.CreateMicrovmImageInput{
		Name:         aws.String(in.ImageName),
		BaseImageArn: aws.String(spec.BaseImageArn),
		BuildRoleArn: aws.String(spec.BuildRoleArn),
		CodeArtifact: &types.CodeArtifactMemberUri{Value: in.ArtifactURI},
		// ARM_64 is the only architecture Lambda MicroVMs accepts, and the
		// binaries inherited from the base artifact are arm64. Stating it
		// keeps the two from drifting, exactly as publish.sh does.
		CpuConfigurations: []types.CpuConfiguration{{Architecture: types.ArchitectureArm64}},
		// Custom templates are pinned to the DEFAULT tier. Memory is a property
		// of the image here, so offering N tiers per template would mean N
		// images per template; until that is worth its cost, a template is one
		// image at the default floor and the tier is chosen by the base image.
		Resources: []types.Resources{{MinimumMemoryInMiB: aws.Int32(mem)}},
		Hooks:     templateHooks(),
		Logging:   &types.LoggingMemberCloudWatch{Value: types.CloudWatchLogging{LogGroup: aws.String(logGroupFor(in.ImageName))}},
		Tags:      in.Tags,
	})
	if err != nil {
		return "", fmt.Errorf("create microvm image %s: %w", in.ImageName, err)
	}
	if out.ImageArn == nil || *out.ImageArn == "" {
		return "", fmt.Errorf("create microvm image %s returned no ARN", in.ImageName)
	}
	return *out.ImageArn, nil
}

// templateHooks mirrors deploy/microvm/publish.sh exactly. The long ready and
// validate timeouts are not padding: /validate deliberately exercises the exec
// path to drive snapshot-region prefetch, and a custom template's extra layers
// only make that slower.
func templateHooks() *types.Hooks {
	enabled := func(sec int32) *int32 { return aws.Int32(sec) }
	return &types.Hooks{
		Port: aws.Int32(8080),
		MicrovmHooks: &types.MicrovmHooks{
			Run: types.HookStateEnabled, RunTimeoutInSeconds: enabled(30),
			Resume: types.HookStateEnabled, ResumeTimeoutInSeconds: enabled(30),
			Suspend: types.HookStateEnabled, SuspendTimeoutInSeconds: enabled(30),
			Terminate: types.HookStateEnabled, TerminateTimeoutInSeconds: enabled(30),
		},
		MicrovmImageHooks: &types.MicrovmImageHooks{
			Ready: types.HookStateEnabled, ReadyTimeoutInSeconds: enabled(300),
			Validate: types.HookStateEnabled, ValidateTimeoutInSeconds: enabled(300),
		},
	}
}

func logGroupFor(name string) string { return "/aws/lambda/microvms/" + name }

// checkImageAPI turns "this cell has no image builder configured" into a clear
// error at the entry point rather than a nil dereference several calls deep.
func (c *Client) checkImageAPI() error {
	if c.imageAPI == nil {
		return fmt.Errorf("awsvm: image management is not configured on this client — custom templates are unavailable")
	}
	return nil
}

// WaitForImage blocks until the image leaves CREATING.
//
// A failed build surfaces as a bare CREATE_FAILED with no detail on the image
// itself, which is unactionable — the customer cannot tell a typo'd package
// from an x86 binary on an ARM-only platform. The reason lives on the BUILD
// record, so fetch it and put it in the error, along with the log group where
// the full output is.
func (c *Client) WaitForImage(ctx context.Context, imageARN, imageName string) error {
	const (
		poll     = 5 * time.Second
		deadline = 30 * time.Minute
	)
	stop := time.Now().Add(deadline)
	for {
		out, err := c.imageAPI.GetMicrovmImage(ctx, &lambdamicrovms.GetMicrovmImageInput{
			ImageIdentifier: aws.String(imageARN),
		})
		if err != nil {
			return fmt.Errorf("poll image %s: %w", imageARN, err)
		}
		switch out.State {
		case types.MicrovmImageStateCreated, types.MicrovmImageStateUpdated:
			return nil
		case types.MicrovmImageStateCreateFailed, types.MicrovmImageStateUpdateFailed:
			return fmt.Errorf("image build failed (%s): %s; full output in CloudWatch log group %s",
				out.State, c.buildFailureReason(ctx, imageARN, out.LatestFailedImageVersion), logGroupFor(imageName))
		}
		if time.Now().After(stop) {
			return fmt.Errorf("image %s still %s after %s; see CloudWatch log group %s",
				imageARN, out.State, deadline, logGroupFor(imageName))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(poll):
		}
	}
}

// buildFailureReason is best-effort: it enriches an error that is already going
// to be returned, so a failure to fetch the reason must not replace the real
// one.
func (c *Client) buildFailureReason(ctx context.Context, imageARN string, version *string) string {
	if version == nil || *version == "" {
		return "no failed build version reported"
	}
	out, err := c.imageAPI.GetMicrovmImageBuild(ctx, &lambdamicrovms.GetMicrovmImageBuildInput{
		ImageIdentifier: aws.String(imageARN),
		ImageVersion:    version,
	})
	if err != nil {
		log.Printf("awsvm: could not fetch build detail for %s v%s: %v", imageARN, *version, err)
		return "build reason unavailable"
	}
	if out.StateReason == nil || *out.StateReason == "" {
		return "build reported no reason"
	}
	return strings.TrimSpace(*out.StateReason)
}

// DeleteTemplateImage removes a custom-template image.
//
// Only ever called with an ARN read back from our own template registry. This
// AWS account is shared with a customer-serving workload, and publish.sh is
// careful never to touch an image it did not create; the same rule applies
// here, which is why there is no "delete by name pattern" helper.
func (c *Client) DeleteTemplateImage(ctx context.Context, imageARN string) error {
	if err := c.checkImageAPI(); err != nil {
		return err
	}
	_, err := c.imageAPI.DeleteMicrovmImage(ctx, &lambdamicrovms.DeleteMicrovmImageInput{
		ImageIdentifier: aws.String(imageARN),
	})
	if err != nil {
		return fmt.Errorf("delete microvm image %s: %w", imageARN, err)
	}
	return nil
}

func copyZipEntry(zw *zip.Writer, f *zip.File) error {
	rc, err := f.Open()
	if err != nil {
		return fmt.Errorf("open %s in base artifact: %w", f.Name, err)
	}
	defer rc.Close()
	hdr := f.FileHeader
	w, err := zw.CreateHeader(&hdr)
	if err != nil {
		return fmt.Errorf("write %s: %w", f.Name, err)
	}
	if _, err := io.Copy(w, rc); err != nil {
		return fmt.Errorf("copy %s: %w", f.Name, err)
	}
	return nil
}

func writeZipFile(zw *zip.Writer, name string, content []byte) error {
	w, err := zw.Create(name)
	if err != nil {
		return fmt.Errorf("create %s in artifact: %w", name, err)
	}
	if _, err := w.Write(content); err != nil {
		return fmt.Errorf("write %s in artifact: %w", name, err)
	}
	return nil
}
