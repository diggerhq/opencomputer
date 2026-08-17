package awsvm

import (
	"context"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
)

// TestIntegrationInspectImages answers the image half of the plan: what base
// images Lambda offers to build on, and what the existing images in this
// account actually are. MicroVM images are NOT bring-your-own-OCI — a build
// layers a code artifact onto a Lambda-managed base — so the available bases
// determine how close we can get to our own `base` template.
//
//	AWSVM_INTEGRATION=1 AWS_REGION=us-east-1 go test ./internal/awsvm/ -run TestIntegrationInspectImages -v
func TestIntegrationInspectImages(t *testing.T) {
	client, _ := integrationClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	managed, err := client.ListManagedMicrovmImages(ctx, &lambdamicrovms.ListManagedMicrovmImagesInput{})
	if err != nil {
		t.Fatalf("ListManagedMicrovmImages: %v", err)
	}
	t.Logf("Lambda-managed base images: %d", len(managed.Items))
	for _, m := range managed.Items {
		t.Logf("  base arn=%s", aws.ToString(m.ImageArn))
	}

	// Deliberately NOT enumerating or inspecting the images already in this
	// account. It is shared with managed-agents, which serves customers, and
	// this package has no business reading their build metadata. Anything we
	// need, we build under our own distinctly-named image.
}
