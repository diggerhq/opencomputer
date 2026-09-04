package awsvm

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
)

// Quota exhaustion and throttling arrive as different AWS types and demand
// opposite responses — stop vs retry. These pin that they never collapse into
// each other, because the code path only runs when a region is actually full,
// which is exactly when nobody is watching.
func TestClassifyLaunchErrorSeparatesQuotaFromThrottle(t *testing.T) {
	cases := []struct {
		name    string
		in      error
		isQuota bool
		isThrot bool
	}{
		{"quota", &types.ServiceQuotaExceededException{}, true, false},
		{"throttling", &types.ThrottlingException{}, false, true},
		{"too many requests", &types.TooManyRequestsException{}, false, true},
		{"unrelated", errors.New("connection reset"), false, false},
		{"validation", &types.ValidationException{}, false, false},
	}
	for _, tc := range cases {
		got := classifyLaunchError(tc.in)
		if errors.Is(got, ErrQuotaExceeded) != tc.isQuota {
			t.Errorf("%s: ErrQuotaExceeded=%v, want %v", tc.name, !tc.isQuota, tc.isQuota)
		}
		if errors.Is(got, ErrThrottled) != tc.isThrot {
			t.Errorf("%s: ErrThrottled=%v, want %v", tc.name, !tc.isThrot, tc.isThrot)
		}
	}
}

// The original AWS error must survive classification — it carries the request
// id and message an operator needs, and losing it would leave only our label.
func TestClassifyLaunchErrorKeepsTheCause(t *testing.T) {
	cause := &types.ServiceQuotaExceededException{}
	got := classifyLaunchError(cause)
	var quota *types.ServiceQuotaExceededException
	if !errors.As(got, &quota) {
		t.Fatal("classification discarded the underlying AWS error")
	}
}

// Classification happens below several wrapping layers, so matching must work
// through them.
func TestClassifyLaunchErrorSurvivesWrapping(t *testing.T) {
	wrapped := fmt.Errorf("awsvm: run microvm: %w", classifyLaunchError(&types.ServiceQuotaExceededException{}))
	if !errors.Is(wrapped, ErrQuotaExceeded) {
		t.Fatal("wrapping hid the quota classification")
	}
}

func TestClassifyLaunchErrorPassesNil(t *testing.T) {
	if got := classifyLaunchError(nil); got != nil {
		t.Fatalf("classifyLaunchError(nil) = %v, want nil", got)
	}
}

// getNotFoundAPI answers GetMicrovm the way AWS does for a host it has no
// record of — the steady state for a box terminated some time ago.
type getNotFoundAPI struct {
	API
	err error
}

func (f *getNotFoundAPI) GetMicrovm(context.Context, *lambdamicrovms.GetMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.GetMicrovmOutput, error) {
	return nil, f.err
}

// A host AWS has forgotten must be reported as TERMINAL, distinctly from a
// lookup that merely failed.
//
// This is the leak that motivated the sentinel. Reconcile's rule is "never
// close a row on an error" — correct for a throttle, catastrophic for
// not-found, because the error is permanent: the box will never come back, so
// the row sits `running` for the life of the database and the sandbox shows as
// live to the customer forever. Measured on dev as three such rows, skipped
// silently on every 5-minute pass.
func TestGetReportsAForgottenHostAsTerminalNotTransient(t *testing.T) {
	c := NewClientWithAPI(&getNotFoundAPI{err: &types.ResourceNotFoundException{}}, Config{ImageIdentifier: "arn:image"})

	_, err := c.Get(context.Background(), "microvm-gone")
	if err == nil {
		t.Fatal("Get succeeded for a host AWS does not have")
	}
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("not-found was not classified as terminal (%v) — the reconciler "+
			"would treat it as 'could not tell' and never close the row", err)
	}
	// The opposite direction matters just as much: a transient failure must NOT
	// look like proof the host is gone, or a throttle ends live sandboxes.
	if errors.Is(err, ErrThrottled) {
		t.Fatal("not-found also matched ErrThrottled — the two must stay distinguishable")
	}
}

func TestGetKeepsTransientFailuresTransient(t *testing.T) {
	for name, apiErr := range map[string]error{
		"throttling":    &types.ThrottlingException{},
		"too many reqs": &types.TooManyRequestsException{},
	} {
		t.Run(name, func(t *testing.T) {
			c := NewClientWithAPI(&getNotFoundAPI{err: apiErr}, Config{ImageIdentifier: "arn:image"})
			_, err := c.Get(context.Background(), "microvm-1")
			if errors.Is(err, ErrNotFound) {
				t.Fatal("a transient failure was classified as proof the host is gone — " +
					"the reconciler would close a LIVE customer's sandbox")
			}
			if !errors.Is(err, ErrThrottled) {
				t.Fatalf("transient failure not classified as throttled: %v", err)
			}
		})
	}
}
