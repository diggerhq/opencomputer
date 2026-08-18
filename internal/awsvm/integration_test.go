package awsvm

import (
	"context"
	"os"
	"testing"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
)

// integration_test.go — tests that talk to real AWS.
//
// Skipped unless AWSVM_INTEGRATION=1, so `go test ./...` stays hermetic. These
// exist because the questions that decide this backend's architecture — is the
// service even enabled for us, how long does a cold RunMicrovm actually take at
// burst width, does it throttle — cannot be answered from documentation.
//
//	AWSVM_INTEGRATION=1 AWS_REGION=us-east-1 go test ./internal/awsvm/ -run Integration -v

func integrationClient(t *testing.T) (*lambdamicrovms.Client, string) {
	t.Helper()
	if os.Getenv("AWSVM_INTEGRATION") != "1" {
		t.Skip("set AWSVM_INTEGRATION=1 to run tests against real AWS")
	}
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = "us-east-1"
	}
	cfg, err := awsconfig.LoadDefaultConfig(context.Background(), awsconfig.WithRegion(region))
	if err != nil {
		t.Fatalf("load AWS config: %v", err)
	}
	return lambdamicrovms.NewFromConfig(cfg), region
}

// TestIntegrationDiscover answers the three go/no-go questions in one shot:
// can this account see the service, is there an image we can borrow, and is
// anything already running that would be eating quota.
func TestIntegrationDiscover(t *testing.T) {
	client, region := integrationClient(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	t.Logf("region=%s", region)

	// Reachability only — counts, never contents. This account is shared with
	// managed-agents, which serves customers; enumerating their images or VMs
	// is none of this package's business. Our own resources are identified by
	// the names we give them, not by trawling the account.
	images, err := client.ListMicrovmImages(ctx, &lambdamicrovms.ListMicrovmImagesInput{})
	if err != nil {
		t.Fatalf("ListMicrovmImages failed — the service may not be enabled for this account: %v", err)
	}
	vms, err := client.ListMicrovms(ctx, &lambdamicrovms.ListMicrovmsInput{})
	if err != nil {
		t.Fatalf("ListMicrovms: %v", err)
	}
	t.Logf("service reachable: %d image(s), %d microvm(s) exist in this account",
		len(images.Items), len(vms.Items))
}
