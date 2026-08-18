package awsvm

import (
	"errors"
	"fmt"
	"testing"

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
