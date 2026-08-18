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
