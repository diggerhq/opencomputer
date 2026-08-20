package awsvm

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
)

// fakeAPI records what the client asked AWS for, so the tests can assert on the
// request rather than on a live service.
type fakeAPI struct {
	API
	runIn     *lambdamicrovms.RunMicrovmInput
	tokenIn   *lambdamicrovms.CreateMicrovmAuthTokenInput
	tokenHits int
	listPages [][]types.MicrovmItem
}

func (f *fakeAPI) RunMicrovm(_ context.Context, in *lambdamicrovms.RunMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.RunMicrovmOutput, error) {
	f.runIn = in
	return &lambdamicrovms.RunMicrovmOutput{
		MicrovmId: aws.String("mvm-1"),
		Endpoint:  aws.String("abc.microvm.aws.dev"),
		ImageArn:  aws.String("arn:image"),
	}, nil
}

func (f *fakeAPI) CreateMicrovmAuthToken(_ context.Context, in *lambdamicrovms.CreateMicrovmAuthTokenInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.CreateMicrovmAuthTokenOutput, error) {
	f.tokenIn = in
	f.tokenHits++
	return &lambdamicrovms.CreateMicrovmAuthTokenOutput{
		AuthToken: map[string]string{"X-aws-proxy-auth": "jwe-value"},
	}, nil
}

func (f *fakeAPI) ListMicrovms(_ context.Context, in *lambdamicrovms.ListMicrovmsInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.ListMicrovmsOutput, error) {
	page := 0
	if in.NextToken != nil {
		page = 1
	}
	out := &lambdamicrovms.ListMicrovmsOutput{Items: f.listPages[page]}
	if page == 0 && len(f.listPages) > 1 {
		out.NextToken = aws.String("next")
	}
	return out, nil
}

func (f *fakeAPI) TerminateMicrovm(_ context.Context, _ *lambdamicrovms.TerminateMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.TerminateMicrovmOutput, error) {
	return &lambdamicrovms.TerminateMicrovmOutput{}, nil
}

// A MicroVM may not outlive the service ceiling; an over-large config must be
// clamped rather than passed through to be rejected at run time.
func TestRunClampsMaximumDurationToCeiling(t *testing.T) {
	f := &fakeAPI{}
	c := NewClientWithAPI(f, Config{ImageIdentifier: "arn:image", MaxDurationSeconds: 999_999})

	if _, err := c.Run(context.Background(), "tok"); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := aws.ToInt32(f.runIn.MaximumDurationInSeconds); got != maxDurationCeilingSeconds {
		t.Fatalf("MaximumDurationInSeconds = %d, want clamped to %d", got, maxDurationCeilingSeconds)
	}
	if aws.ToString(f.runIn.ClientToken) != "tok" {
		t.Fatalf("ClientToken not forwarded — retries would leak a second VM and burn quota")
	}
}

// The token must be scoped to the agent port. Minting an allPorts token would
// let a leaked JWE reach any service in the guest.
func TestAuthTokenScopedToAgentPortAndCached(t *testing.T) {
	f := &fakeAPI{}
	c := NewClientWithAPI(f, Config{ImageIdentifier: "arn:image", AgentPort: 9099})

	v, err := c.AuthToken(context.Background(), "mvm-1")
	if err != nil {
		t.Fatalf("AuthToken: %v", err)
	}
	if v != "jwe-value" {
		t.Fatalf("token = %q, want jwe-value", v)
	}
	if got := aws.ToInt32(f.tokenIn.ExpirationInMinutes); got > authTokenMaxMinutes {
		t.Fatalf("ExpirationInMinutes = %d exceeds the service max of %d", got, authTokenMaxMinutes)
	}
	port, ok := f.tokenIn.AllowedPorts[0].(*types.PortSpecificationMemberPort)
	if !ok || port.Value != 9099 {
		t.Fatalf("AllowedPorts = %#v, want a single-port spec for 9099", f.tokenIn.AllowedPorts)
	}

	// Second call inside the refresh window must not hit the API — token minting
	// on the exec path is indistinguishable from a slow sandbox.
	if _, err := c.AuthToken(context.Background(), "mvm-1"); err != nil {
		t.Fatalf("AuthToken (cached): %v", err)
	}
	if f.tokenHits != 1 {
		t.Fatalf("minted %d tokens, want 1 (cache miss on the hot path)", f.tokenHits)
	}
}

// A stale cache entry must be re-minted, or a long-lived sandbox starts failing
// the moment its first token expires.
func TestAuthTokenRefreshesWhenStale(t *testing.T) {
	f := &fakeAPI{}
	c := NewClientWithAPI(f, Config{ImageIdentifier: "arn:image"})

	if _, err := c.AuthToken(context.Background(), "mvm-1"); err != nil {
		t.Fatalf("AuthToken: %v", err)
	}
	c.mu.Lock()
	c.tokens["mvm-1"].refreshAt = time.Now().Add(-time.Minute)
	c.mu.Unlock()

	if _, err := c.AuthToken(context.Background(), "mvm-1"); err != nil {
		t.Fatalf("AuthToken (stale): %v", err)
	}
	if f.tokenHits != 2 {
		t.Fatalf("minted %d tokens, want 2 (stale entry must refresh)", f.tokenHits)
	}
}

// Terminate must drop the cached token; reusing an id (or leaking entries) would
// hand out a token for a VM that no longer exists.
func TestTerminateForgetsToken(t *testing.T) {
	f := &fakeAPI{}
	c := NewClientWithAPI(f, Config{ImageIdentifier: "arn:image"})
	if _, err := c.AuthToken(context.Background(), "mvm-1"); err != nil {
		t.Fatalf("AuthToken: %v", err)
	}
	if err := c.Terminate(context.Background(), "mvm-1"); err != nil {
		t.Fatalf("Terminate: %v", err)
	}
	c.mu.Lock()
	_, still := c.tokens["mvm-1"]
	c.mu.Unlock()
	if still {
		t.Fatal("token cache still holds an entry for a terminated MicroVM")
	}
}

// Losing track of a VM means leaking regional memory quota, so List has to walk
// every page rather than stopping at the first.
func TestListPaginates(t *testing.T) {
	f := &fakeAPI{listPages: [][]types.MicrovmItem{
		{{MicrovmId: aws.String("mvm-1"), State: types.MicrovmStateRunning}},
		{{MicrovmId: aws.String("mvm-2"), State: types.MicrovmStateSuspended}},
	}}
	c := NewClientWithAPI(f, Config{ImageIdentifier: "arn:image"})

	boxes, err := c.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(boxes) != 2 {
		t.Fatalf("got %d boxes, want 2 — pagination stopped early", len(boxes))
	}
}

func TestAliveExcludesTerminalStates(t *testing.T) {
	for _, tc := range []struct {
		state types.MicrovmState
		alive bool
	}{
		{types.MicrovmStateRunning, true},
		{types.MicrovmStateSuspended, true}, // auto-resume can still serve it
		{types.MicrovmStatePending, true},
		{types.MicrovmStateTerminating, false},
		{types.MicrovmStateTerminated, false},
	} {
		if got := (Box{State: tc.state}).Alive(); got != tc.alive {
			t.Errorf("Alive(%s) = %v, want %v", tc.state, got, tc.alive)
		}
	}
}

func TestAgentURLNormalisesScheme(t *testing.T) {
	for in, want := range map[string]string{
		"abc.microvm.aws.dev":         "https://abc.microvm.aws.dev",
		"https://abc.microvm.aws.dev": "https://abc.microvm.aws.dev",
		"":                            "",
	} {
		if got := AgentURL(in); got != want {
			t.Errorf("AgentURL(%q) = %q, want %q", in, got, want)
		}
	}
}

// shortenListBackoff collapses the retry ladder so a test can assert on attempt
// counts without waiting out the production delays.
func shortenListBackoff(t *testing.T) {
	t.Helper()
	prev := listBackoff
	listBackoff = time.Millisecond
	t.Cleanup(func() { listBackoff = prev })
}

// throttleAPI fails the first `failures` ListMicrovms calls with the error the
// account actually returns under load, then succeeds.
type throttleAPI struct {
	fakeAPI
	failures int
	calls    int
	err      error
}

func (f *throttleAPI) ListMicrovms(ctx context.Context, in *lambdamicrovms.ListMicrovmsInput, opts ...func(*lambdamicrovms.Options)) (*lambdamicrovms.ListMicrovmsOutput, error) {
	f.calls++
	if f.calls <= f.failures {
		return nil, f.err
	}
	return f.fakeAPI.ListMicrovms(ctx, in, opts...)
}

// List is the only way the control plane sees a box with no database row, so a
// List that gives up silently turns the orphan sweep into a no-op and leaked
// hosts bill and hold regional quota forever. On a busy account this call is
// throttled harder than the rest of the API — observed failing on most passes
// with the SDK's own "exceeded maximum number of attempts, 3" — so it has to be
// more patient than the SDK default.
func TestListRetriesThrottledPages(t *testing.T) {
	shortenListBackoff(t)
	f := &throttleAPI{
		failures: 3,
		err:      &types.ThrottlingException{},
	}
	f.listPages = [][]types.MicrovmItem{{{MicrovmId: aws.String("mvm-1")}}}
	c := NewClientWithAPI(f, Config{ImageIdentifier: "arn:image"})

	boxes, err := c.List(context.Background())
	if err != nil {
		t.Fatalf("List gave up on a throttle the sweep depends on: %v", err)
	}
	if len(boxes) != 1 {
		t.Fatalf("List returned %d boxes, want 1", len(boxes))
	}
	if f.calls != 4 {
		t.Fatalf("made %d calls, want 4 (3 throttled + 1 success)", f.calls)
	}
}

// Retrying a permissions or validation failure just delays the same answer.
// Worse, it would hold the reconcile tick for the full backoff ladder every
// pass, so the sweep runs less often precisely when it is already broken.
func TestListDoesNotRetryNonThrottleErrors(t *testing.T) {
	f := &throttleAPI{
		failures: 99,
		err:      errors.New("AccessDeniedException: not authorized"),
	}
	f.listPages = [][]types.MicrovmItem{{}}
	c := NewClientWithAPI(f, Config{ImageIdentifier: "arn:image"})

	if _, err := c.List(context.Background()); err == nil {
		t.Fatal("List hid a non-throttle failure")
	}
	if f.calls != 1 {
		t.Fatalf("made %d calls for a permanent error, want 1", f.calls)
	}
}

// A throttle that never clears must still terminate, and must report the cause
// rather than an empty inventory — an empty list would read as "no orphans".
func TestListGivesUpAfterListAttempts(t *testing.T) {
	shortenListBackoff(t)
	f := &throttleAPI{
		failures: 99,
		err:      &types.ThrottlingException{},
	}
	f.listPages = [][]types.MicrovmItem{{}}
	c := NewClientWithAPI(f, Config{ImageIdentifier: "arn:image"})

	boxes, err := c.List(context.Background())
	if err == nil {
		t.Fatal("List reported success while permanently throttled — the sweep would read an empty inventory as 'no orphans'")
	}
	if boxes != nil {
		t.Fatalf("List returned %d boxes alongside an error", len(boxes))
	}
	if f.calls != listAttempts {
		t.Fatalf("made %d attempts, want listAttempts=%d", f.calls, listAttempts)
	}
}
