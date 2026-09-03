package api

// template_microvm_build.go — CT-0: materialising an ImageManifest on the
// MicroVM runtime.
//
// The two runtimes build the SAME customer-facing manifest into different
// artifacts, because they can only persist different things:
//
//	QEMU     manifest -> boot a box -> run each step as a shell command
//	                  -> checkpoint (captures the WHOLE rootfs)
//	MicroVM  manifest -> render a Dockerfile -> create-microvm-image
//	                  -> an image ARN
//
// The MicroVM runtime cannot use the QEMU mechanism: /oc/workspace/export
// archives /home/sandbox and nothing else, so a `dnf install` into /usr does not
// survive the checkpoint. That was measured, not assumed — an overlay-based
// alternative was built and rejected on restore latency (~0.4s per MB against a
// flat 1.9-7.9s cold launch). Baking the packages into an image is the only
// mechanism that persists system state here.
//
// resolveImageManifest is therefore NOT the funnel for both. It returns a
// checkpoint ID, which does not exist on this runtime; dispatching by runtime
// before it is what keeps the two from being conflated.

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"

	"github.com/opensandbox/opensandbox/internal/awsvm"
	"github.com/opensandbox/opensandbox/internal/db"
)

// microvmImageBuilder is what this needs from the AWS client, narrowed to two
// methods so the dispatch logic is testable without AWS.
type microvmImageBuilder interface {
	BuildTemplateImage(ctx context.Context, store awsvm.ObjectStore, in awsvm.TemplateBuildInput) (string, error)
}

// buildMicrovmImageTemplate turns a manifest into a ready template row holding
// an image ARN.
//
// Ordering is the contract, and each step exists to prevent a specific failure:
//
//  1. DEDUPE first, before anything is created. An identical manifest must
//     reuse its image rather than take a second slot out of an account capped
//     at 100.
//  2. QUOTA next, before the row. Checking after would let an org accumulate
//     'processing' rows it can never finish.
//  3. ROW before the build. A build that dies partway is then a visible stuck
//     template rather than nothing at all — an invisible failed build is
//     indistinguishable from a template the customer never created.
//  4. BUILD, which takes minutes.
//  5. ARN and 'ready' in one statement, or 'failed' — never a ready row with no
//     ARN, which create-time resolution cannot launch.
//
// Blocking. Callers that must not block (the create path) run it in a goroutine
// and let the customer poll the template's status, which is the same contract
// the snapshot path already offers.
func (s *Server) buildMicrovmImageTemplate(
	ctx context.Context,
	orgID uuid.UUID,
	name string,
	manifestJSON json.RawMessage,
	builder microvmImageBuilder,
	objects awsvm.ObjectStore,
	artifactPrefix string,
) (*db.DBTemplate, error) {
	if s.store == nil {
		return nil, fmt.Errorf("microvm template build requires a database")
	}
	var manifest ImageManifest
	if err := json.Unmarshal(manifestJSON, &manifest); err != nil {
		return nil, fmt.Errorf("invalid image manifest: %w", err)
	}
	contentHash := computeManifestHash(&manifest)

	// 1. Dedupe.
	if existing, err := s.store.FindMicrovmImageTemplateByTag(ctx, orgID, contentHash); err == nil && existing != nil {
		log.Printf("microvm-template: %q reuses image %s (hash %s)", name, existing.ImageRef, contentHash[:12])
		return existing, nil
	}

	// 2. Quota.
	used, err := s.store.CountMicrovmImageTemplates(ctx, orgID)
	if err != nil {
		return nil, fmt.Errorf("count template images: %w", err)
	}
	if err := checkTemplateQuota(used); err != nil {
		return nil, err
	}

	// 3. Row, before the build.
	id := uuid.New()
	tmpl, err := s.store.CreateMicrovmImageTemplate(ctx, id, &orgID, name, contentHash)
	if err != nil {
		return nil, fmt.Errorf("create template row: %w", err)
	}

	// 4. Render + build.
	dockerfile, files, err := RenderMicrovmDockerfile(manifest)
	if err != nil {
		_ = s.store.SetTemplateFailed(ctx, id)
		return nil, fmt.Errorf("render template %q: %w", name, err)
	}
	ctxFiles := make(map[string][]byte, len(files))
	for _, f := range files {
		ctxFiles[f.ContextPath] = f.Content
	}
	imageName := templateImageName(orgID.String(), contentHash)
	arn, err := builder.BuildTemplateImage(ctx, objects, awsvm.TemplateBuildInput{
		ImageName:    imageName,
		Dockerfile:   dockerfile,
		ContextFiles: ctxFiles,
		ArtifactURI:  fmt.Sprintf("%s/%s.zip", artifactPrefix, imageName),
		Tags:         templateImageTags(orgID.String()),
	})
	if err != nil {
		// Mark failed on a SEPARATE context: ctx may already be cancelled (this
		// runs in a background goroutine whose request is long gone), and a
		// failed mark that silently no-ops leaves the row stuck in 'processing'
		// forever — exactly the state step 3 exists to make visible.
		markCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if mErr := s.store.SetTemplateFailed(markCtx, id); mErr != nil {
			log.Printf("microvm-template: %q build failed AND could not be marked failed: %v (build error: %v)", name, mErr, err)
		}
		return nil, fmt.Errorf("build template image %q: %w", name, err)
	}

	// 5. ARN + ready, atomically.
	readyCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.store.SetMicrovmTemplateImage(readyCtx, id, arn); err != nil {
		return nil, fmt.Errorf("record template image %s: %w", arn, err)
	}
	tmpl.ImageRef = arn
	tmpl.Status = db.TemplateStatusReady
	log.Printf("microvm-template: %q ready as %s (hash %s)", name, arn, contentHash[:12])
	return tmpl, nil
}

// ErrInlineManifestUnsupported is returned when a create carries an inline
// image manifest on the MicroVM runtime.
//
// Not a silent fallback to the base image, and not a synchronous build either:
// a MicroVM image build takes MINUTES (measured: ~29s for one dnf package plus
// image creation), and a create that blocked that long would time out at every
// layer between the customer and here. Naming the supported path is the only
// honest answer.
var ErrInlineManifestUnsupported = fmt.Errorf(
	"building an image inline during create is not supported on this runtime; " +
		"create the image as a snapshot/template first, then create with template=<name>")
