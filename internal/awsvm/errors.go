package awsvm

import (
	"errors"

	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
)

// Launch failures split into two kinds that must not be conflated, because the
// right answer to each is opposite:
//
//   - ErrQuotaExceeded is terminal for now. The account is at its regional
//     MicroVM memory ceiling and no amount of retrying frees a slot; the only
//     fixes are a customer sandbox ending or AWS raising the quota. Callers
//     should say "out of capacity" and stop.
//   - ErrThrottled is transient. RunMicrovm is rate-limited (5/s), so this
//     means "too fast", not "too full" — the same request a moment later
//     succeeds. Retrying is correct.
//
// Reporting a throttle as out-of-capacity would tell an operator to raise a
// quota that is not the problem; reporting a quota exhaustion as a throttle
// would spin retries against a wall.
var (
	ErrQuotaExceeded = errors.New("awsvm: regional MicroVM quota exhausted")
	ErrThrottled     = errors.New("awsvm: MicroVM API rate limit exceeded")
)

// ErrUnsupported marks a Manager capability this runtime does not implement.
// Callers should surface it as "not available on this runtime", never retry it.
//
// The API boundary substitutes its own text, so this string is not
// customer-visible today — but error text is exactly what escapes into a
// response, a webhook, or a support ticket later, so it stays generic.
var ErrUnsupported = errors.New("awsvm: operation not supported by this sandbox runtime")

// ErrNotFound marks a host AWS has no record of — TERMINAL, and the distinction
// from a transient lookup failure is the whole point of the sentinel.
//
// Reconcile's rule is "never close a row on an error", because a throttle or a
// timeout must not be allowed to end a live customer's sandbox. But GetMicrovm
// answers ResourceNotFoundException for a box that is genuinely gone, and
// lumping that in with transient errors made the rule say "never close this row
// EVER" — the box is permanently absent, so the error recurs forever and the
// row sits `running` for the life of the database. Measured on dev as three
// rows the reconciler skipped silently on every pass.
//
// A caller may treat this, and only this, as proof the host is gone.
var ErrNotFound = errors.New("awsvm: microvm does not exist")

// classifyLaunchError maps an AWS launch error onto the sentinels above,
// leaving anything else untouched. Errors are matched by type rather than by
// message so an SDK wording change cannot silently reclassify them.
func classifyLaunchError(err error) error {
	if err == nil {
		return nil
	}
	var quota *types.ServiceQuotaExceededException
	if errors.As(err, &quota) {
		return errors.Join(ErrQuotaExceeded, err)
	}
	var throttle *types.ThrottlingException
	if errors.As(err, &throttle) {
		return errors.Join(ErrThrottled, err)
	}
	var tooMany *types.TooManyRequestsException
	if errors.As(err, &tooMany) {
		return errors.Join(ErrThrottled, err)
	}
	return err
}

// classifyLookupError maps a describe/lookup error onto the sentinels above.
// Separate from classifyLaunchError because the interesting case is the
// opposite one: a launch never returns not-found, and a lookup never returns
// quota-exceeded.
func classifyLookupError(err error) error {
	if err == nil {
		return nil
	}
	var missing *types.ResourceNotFoundException
	if errors.As(err, &missing) {
		return errors.Join(ErrNotFound, err)
	}
	var throttle *types.ThrottlingException
	if errors.As(err, &throttle) {
		return errors.Join(ErrThrottled, err)
	}
	var tooMany *types.TooManyRequestsException
	if errors.As(err, &tooMany) {
		return errors.Join(ErrThrottled, err)
	}
	return err
}
