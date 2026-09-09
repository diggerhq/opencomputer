package api

import (
	"errors"
	"strings"
	"testing"

	"github.com/opensandbox/opensandbox/internal/awsvm"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// A size we do not publish must be refused with a reason the customer can act
// on. The failure this guards against is not the refusal — Accepts already
// declines correctly — it is the refusal arriving as "out of capacity", which
// tells someone to wait for a shortage that will never clear.
func TestSizeRefusalNamesTheSizesActuallyOffered(t *testing.T) {
	cfg := awsvm.Config{
		ImageIdentifier: "arn:default",
		DefaultMemoryMB: 4096,
		SizeImages:      map[int]string{8192: "arn:8192"},
	}

	for _, tc := range []struct {
		name     string
		memoryMB int
		wantErr  bool
	}{
		{"the default size is always offered", 0, false},
		{"an explicitly published tier is offered", 8192, false},
		{"an unpublished tier is refused", 16384, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := &liteBackend{client: awsvm.NewClientWithAPI(nil, cfg)}
			err := b.ExplainRefusal(placement{
				runtime: runtimeMicrovm,
				cfg:     types.SandboxConfig{MemoryMB: tc.memoryMB},
			})
			if tc.wantErr != (err != nil) {
				t.Fatalf("memoryMB=%d: got err=%v, wanted err=%v", tc.memoryMB, err, tc.wantErr)
			}
			if !tc.wantErr {
				return
			}
			if !errors.Is(err, ErrSizeUnavailable) {
				t.Errorf("refusal does not carry ErrSizeUnavailable, so respondCreateErr will fall through to a 503: %v", err)
			}
			// The list is the whole point — "not available" alone leaves the
			// caller guessing at a set only we can see.
			for _, want := range []string{"4096", "8192"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("refusal omits offered size %s: %q", want, err.Error())
				}
			}
		})
	}
}

// A create for another runtime must not be explained by this backend, or every
// QEMU capacity failure would be reported as a MicroVM size problem.
func TestSizeRefusalStaysSilentForOtherRuntimes(t *testing.T) {
	b := &liteBackend{client: awsvm.NewClientWithAPI(nil, awsvm.Config{DefaultMemoryMB: 4096})}
	if err := b.ExplainRefusal(placement{runtime: "", cfg: types.SandboxConfig{MemoryMB: 16384}}); err != nil {
		t.Fatalf("explained a refusal for a non-MicroVM create: %v", err)
	}
}
