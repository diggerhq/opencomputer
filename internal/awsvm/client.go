// Package awsvm backs sandboxes with AWS Lambda MicroVMs instead of locally
// managed QEMU processes.
//
// The shape is deliberately different from internal/qemu: there is no host to
// manage. Every MicroVM is created by an API call and comes back with its own
// dedicated public HTTPS endpoint, so a single regional worker process — holding
// nothing but AWS credentials — can stand in for what used to be a fleet of
// hypervisor hosts. Everything above the worker (edge, control plane, PoolStock,
// billing) keeps working against the same sandbox.Manager contract.
//
// Reaching into a box goes through Lambda's proxy: an HTTPS request to the
// MicroVM's endpoint carrying a JWE in X-aws-proxy-auth and the target guest
// port in X-aws-proxy-port. The proxy speaks HTTP/2, WebSockets, gRPC and SSE,
// which is why our existing in-guest osb-agent can be reused unchanged — it
// just listens on TCP in the image rather than on virtio-serial/vsock.
//
// What this backend does NOT have, by construction: live migration (AWS places
// the VMs), golden-snapshot restore, and S3 checkpoints. Hibernate/wake map onto
// native Suspend/Resume, which preserves memory and disk far more cheaply than
// our savevm/loadvm path ever did.
package awsvm

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
)

const (
	// authTokenMaxMinutes is the service ceiling on token lifetime. Tokens are
	// per-MicroVM and per-port, so a long-lived sandbox outlives every token it
	// is ever issued and the cache below has to refresh in the background.
	authTokenMaxMinutes = 60

	// authTokenRefreshAt is the fraction of a token's life after which we mint a
	// replacement. Refreshing early keeps a token miss off the exec hot path —
	// a create burst that stalls on token minting looks exactly like a slow
	// sandbox to the customer.
	authTokenRefreshAt = 0.75

	// maxDurationCeilingSeconds is the service ceiling on how long a MicroVM may
	// exist, counting RUNNING and SUSPENDED time together. This is the hard
	// product constraint of this backend: there is no such thing as a sandbox
	// that outlives it.
	maxDurationCeilingSeconds = 28_800 // 8 hours
)

// Config is the regional backend configuration. Everything here is fleet-wide;
// per-sandbox variation rides on RunOptions.
type Config struct {
	Region string

	// ImageIdentifier is the MicroVM image ARN holding osb-agent plus the
	// lifecycle hook server. ImageVersion empty means "latest active".
	//
	// This is also the DEFAULT SIZE TIER, and the only one the warm pool stocks.
	// See SizeImages.
	ImageIdentifier string
	ImageVersion    string

	// DefaultMemoryMB is how much memory ImageIdentifier actually delivers —
	// its minimumMemoryInMiB. 0 means the built-in baseline.
	//
	// Configurable rather than constant because it is a property of an image we
	// own and can raise with UpdateMicrovmImage (no rebuild), and because
	// metering reads it: if it drifts from the image, every sandbox on that
	// image is billed for the wrong size.
	DefaultMemoryMB int

	// SizeImages maps a requested memory tier (MB) to the image ARN that
	// delivers it, for tiers OTHER than the default.
	//
	// Sizing is a property of the image on this platform — RunMicrovmInput has
	// no memory or vCPU field, and the only knob anywhere is
	// Resources.MinimumMemoryInMiB at image build/update time. So "offer more
	// sizes" means "run more images", one per tier, selected at launch.
	//
	// Only the default tier is pooled. Every other tier cold-launches, which is
	// the deliberate trade: warm stock is per-image, so N pooled tiers would
	// either multiply idle spend by N or split one pool N ways and destroy the
	// latency the pool exists for.
	//
	// A tier absent from this map is NOT silently served from the default
	// image. It is rejected — see Manager.Create. Handing a 16 GB request a
	// 4 GB box is the silent-wrong-size failure this whole path is built to
	// avoid.
	SizeImages map[int]string

	// ExecutionRoleArn is assumed by the MicroVM itself, for the guest's own AWS
	// access. It is NOT the role this worker uses to call the API.
	ExecutionRoleArn string

	IngressNetworkConnectors []string
	EgressNetworkConnectors  []string

	// AgentPort is the guest TCP port we send agent traffic to. Auth tokens are
	// scoped to it, so a leaked token cannot reach an unrelated guest service.
	//
	// This is the image's declared HOOK port, not the port osb-agent itself
	// binds. Lambda's proxy forwards guest traffic only to the declared port —
	// any other listener is unreachable and returns 502 even while it is
	// demonstrably accepting connections inside the guest. cmd/microvm-hooks
	// therefore serves the hooks and reverse-proxies everything else to the
	// agent, so this port carries both.
	AgentPort int32

	// MaxDurationSeconds bounds a sandbox's total lifetime. Clamped to the
	// service ceiling; 0 means use the ceiling.
	MaxDurationSeconds int32

	// Idle policy. AutoResume lets an exec against a suspended box wake it
	// transparently — Lambda holds the request while it resumes — which is the
	// native version of our wake-on-first-request behaviour.
	AutoResume               bool
	MaxIdleDurationSeconds   int32
	SuspendedDurationSeconds int32
}

func (c *Config) applyDefaults() {
	if c.AgentPort == 0 {
		// The declared hook port — see the field comment for why this is not
		// 8081, which is where the agent actually listens.
		c.AgentPort = 8080
	}
	if c.MaxDurationSeconds <= 0 || c.MaxDurationSeconds > maxDurationCeilingSeconds {
		c.MaxDurationSeconds = maxDurationCeilingSeconds
	}
	if c.MaxIdleDurationSeconds <= 0 {
		// Both idle timers default to the total-lifetime ceiling, which means
		// neither can fire before the 8h cap does. That leaves ONE deadline to
		// reason about instead of three interacting ones.
		//
		// The previous defaults (900 idle / 1800 suspended) were measured doing
		// real damage. AWS counts a box idle when no request arrives through its
		// PROXY ENDPOINT — an established agent tunnel carrying h2 PINGs is not
		// proxy traffic and does not count — so pool stock suspended after 15
		// minutes of waiting despite a keepalive that was pinging it every 30s.
		// A suspended box answers the proxy with 502, which is exactly the 502
		// that was failing customer execs, and 30 minutes later AWS terminated
		// it outright. See Pool.touchIdleTimers for the other half of the fix.
		c.MaxIdleDurationSeconds = maxDurationCeilingSeconds
	}
	if c.SuspendedDurationSeconds <= 0 {
		// Suspended boxes bill snapshot storage rather than compute, so holding
		// them is cheap — but they still count against the region's memory
		// quota, which is what actually caps warm-pool depth.
		//
		// Cheap is not the reason for the ceiling, though. When this timer fires
		// AWS TERMINATES the box and takes its disk with it, so any value short
		// of the cap silently converts "parked sandbox" into "deleted sandbox".
		c.SuspendedDurationSeconds = maxDurationCeilingSeconds
	}
	if c.DefaultMemoryMB <= 0 {
		c.DefaultMemoryMB = deliveredMicrovmMemoryMB
	}
}

// ImageForMemory resolves which image delivers a requested memory tier, and how
// much memory that image actually provides.
//
// memoryMB 0 means "unspecified" — the caller gets the default tier, which is
// the pooled one. Anything matching the default's delivered size is also the
// default tier, so a request that names the size it would get anyway still
// takes the fast path rather than being pushed to a cold launch.
//
// ok=false means the tier is not offered here. Callers MUST surface that as an
// error rather than falling back to the default image: the whole reason this
// returns a bool instead of just defaulting is that a silent downgrade bills a
// customer for one size and hands them another.
func (c Config) ImageForMemory(memoryMB int) (image string, deliveredMB int, ok bool) {
	if memoryMB == 0 || memoryMB == c.DefaultMemoryMB {
		return c.ImageIdentifier, c.DefaultMemoryMB, true
	}
	if arn, found := c.SizeImages[memoryMB]; found && arn != "" {
		return arn, memoryMB, true
	}
	return "", 0, false
}

// IsDefaultTier reports whether a request can be served from warm stock. Only
// the default tier is pooled, so this is what gates a pool claim.
func (c Config) IsDefaultTier(memoryMB int) bool {
	return memoryMB == 0 || memoryMB == c.DefaultMemoryMB
}

// OwnedImages lists every image ARN this cell launches boxes from.
//
// The orphan sweep uses the image ARN as its ownership test, so it has to know
// about every tier — a box launched from a tier image would otherwise look like
// it belongs to nobody and be terminated underneath a live customer.
func (c Config) OwnedImages() []string {
	out := make([]string, 0, 1+len(c.SizeImages))
	if c.ImageIdentifier != "" {
		out = append(out, c.ImageIdentifier)
	}
	for _, arn := range c.SizeImages {
		if arn != "" && arn != c.ImageIdentifier {
			out = append(out, arn)
		}
	}
	return out
}

// Box is one MicroVM as this package sees it.
type Box struct {
	ID        string
	Endpoint  string
	State     types.MicrovmState
	ImageArn  string
	StartedAt time.Time
}

// Alive reports whether the box can still serve traffic — either directly, or
// after an auto-resume. TERMINATING/TERMINATED cannot.
func (b Box) Alive() bool {
	switch b.State {
	case types.MicrovmStatePending, types.MicrovmStateRunning,
		types.MicrovmStateSuspending, types.MicrovmStateSuspended:
		return true
	default:
		return false
	}
}

// API is the subset of the generated client this package uses. Narrow on
// purpose: it keeps the manager unit-testable without the AWS SDK, and makes
// the backend's true blast radius obvious at a glance.
type API interface {
	RunMicrovm(context.Context, *lambdamicrovms.RunMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.RunMicrovmOutput, error)
	GetMicrovm(context.Context, *lambdamicrovms.GetMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.GetMicrovmOutput, error)
	SuspendMicrovm(context.Context, *lambdamicrovms.SuspendMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.SuspendMicrovmOutput, error)
	ResumeMicrovm(context.Context, *lambdamicrovms.ResumeMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.ResumeMicrovmOutput, error)
	TerminateMicrovm(context.Context, *lambdamicrovms.TerminateMicrovmInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.TerminateMicrovmOutput, error)
	ListMicrovms(context.Context, *lambdamicrovms.ListMicrovmsInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.ListMicrovmsOutput, error)
	CreateMicrovmAuthToken(context.Context, *lambdamicrovms.CreateMicrovmAuthTokenInput, ...func(*lambdamicrovms.Options)) (*lambdamicrovms.CreateMicrovmAuthTokenOutput, error)
}

// Client wraps the MicroVM API with the bits every caller needs: idempotent
// runs, a token cache, and state translation.
type Client struct {
	api API
	cfg Config

	mu     sync.Mutex
	tokens map[string]*cachedToken
}

type cachedToken struct {
	value     string
	refreshAt time.Time
	expiresAt time.Time
}

// NewClient builds a Client from an already-resolved AWS config.
func NewClient(awsCfg aws.Config, cfg Config) *Client {
	cfg.applyDefaults()
	return &Client{
		api:    lambdamicrovms.NewFromConfig(awsCfg),
		cfg:    cfg,
		tokens: make(map[string]*cachedToken),
	}
}

// NewClientWithAPI injects a custom API implementation (tests).
func NewClientWithAPI(api API, cfg Config) *Client {
	cfg.applyDefaults()
	return &Client{api: api, cfg: cfg, tokens: make(map[string]*cachedToken)}
}

// Config exposes the resolved configuration (defaults applied).
func (c *Client) Config() Config { return c.cfg }

// Run launches a MicroVM. clientToken makes the call idempotent: a retry after a
// timeout rejoins the original VM instead of leaking a second one, which matters
// because a leaked VM burns regional memory quota until it ages out — and quota
// is what caps warm-pool depth.
func (c *Client) Run(ctx context.Context, clientToken string) (*Box, error) {
	return c.RunImage(ctx, clientToken, c.cfg.ImageIdentifier)
}

// RunImage is Run against a specific image, for size tiers other than the
// default (see Config.SizeImages). An empty image means the default.
//
// Separate entry point rather than a Config field so the warm pool keeps
// launching the default image with no change: the pool is deliberately
// single-tier, and a tier selected per-call must not be able to leak into it.
func (c *Client) RunImage(ctx context.Context, clientToken, image string) (*Box, error) {
	if image == "" {
		image = c.cfg.ImageIdentifier
	}
	in := &lambdamicrovms.RunMicrovmInput{
		ImageIdentifier:          aws.String(image),
		MaximumDurationInSeconds: aws.Int32(c.cfg.MaxDurationSeconds),
		IdlePolicy: &types.IdlePolicy{
			AutoResumeEnabled:        aws.Bool(c.cfg.AutoResume),
			MaxIdleDurationSeconds:   aws.Int32(c.cfg.MaxIdleDurationSeconds),
			SuspendedDurationSeconds: aws.Int32(c.cfg.SuspendedDurationSeconds),
		},
	}
	// ImageVersion pins a version of the DEFAULT image. Version numbers are
	// per-image, so carrying it onto a tier image would either pin an unrelated
	// build or fail outright — a tier image takes its own latest active.
	if c.cfg.ImageVersion != "" && image == c.cfg.ImageIdentifier {
		in.ImageVersion = aws.String(c.cfg.ImageVersion)
	}
	if c.cfg.ExecutionRoleArn != "" {
		in.ExecutionRoleArn = aws.String(c.cfg.ExecutionRoleArn)
	}
	if clientToken != "" {
		in.ClientToken = aws.String(clientToken)
	}
	if len(c.cfg.IngressNetworkConnectors) > 0 {
		in.IngressNetworkConnectors = c.cfg.IngressNetworkConnectors
	}
	if len(c.cfg.EgressNetworkConnectors) > 0 {
		in.EgressNetworkConnectors = c.cfg.EgressNetworkConnectors
	}

	out, err := c.api.RunMicrovm(ctx, in)
	if err != nil {
		// Classified before wrapping so callers can tell "no room left in the
		// region" from "asking too fast" — see errors.go.
		return nil, fmt.Errorf("awsvm: run microvm: %w", classifyLaunchError(err))
	}
	return &Box{
		ID:       aws.ToString(out.MicrovmId),
		Endpoint: aws.ToString(out.Endpoint),
		ImageArn: aws.ToString(out.ImageArn),
		State:    types.MicrovmStatePending,
	}, nil
}

// Get reads a MicroVM's current state.
func (c *Client) Get(ctx context.Context, id string) (*Box, error) {
	out, err := c.api.GetMicrovm(ctx, &lambdamicrovms.GetMicrovmInput{
		MicrovmIdentifier: aws.String(id),
	})
	if err != nil {
		return nil, fmt.Errorf("awsvm: get microvm %s: %w", id, err)
	}
	return &Box{
		ID:       aws.ToString(out.MicrovmId),
		Endpoint: aws.ToString(out.Endpoint),
		ImageArn: aws.ToString(out.ImageArn),
		State:    out.State,
	}, nil
}

// WaitRunning blocks until a box reaches RUNNING, or ctx/timeout expires.
//
// RunMicrovm is asynchronous: it returns an id and endpoint immediately, while
// the VM is still restoring from the image snapshot and has not yet run its
// /run hook. Lambda forwards no traffic until that hook returns 200, so talking
// to a box in PENDING gets 502 Bad Gateway from the proxy — with nothing in the
// guest logs, because the guest genuinely has not been asked to do anything
// yet. Anything that parks boxes for later use must gate on this, or it stocks
// boxes that are not actually ready and the 502 surfaces as a customer-facing
// exec failure.
func (c *Client) WaitRunning(ctx context.Context, id string, timeout time.Duration) (*Box, error) {
	deadline := time.Now().Add(timeout)
	// Poll gently: GetMicrovm has its own rate quota, and a pool topping up many
	// boxes at once would otherwise spend that quota on impatience.
	const pollInterval = 250 * time.Millisecond
	for {
		box, err := c.Get(ctx, id)
		if err != nil {
			return nil, err
		}
		switch box.State {
		case types.MicrovmStateRunning:
			return box, nil
		case types.MicrovmStatePending:
			// still booting
		default:
			// Suspended/terminating/anything else is not something waiting fixes.
			return nil, fmt.Errorf("awsvm: microvm %s reached state %s while waiting for RUNNING", id, box.State)
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("awsvm: microvm %s still PENDING after %s", id, timeout)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(pollInterval):
		}
	}
}

// Suspend snapshots the box's memory and disk and stops billing compute for it.
func (c *Client) Suspend(ctx context.Context, id string) error {
	if _, err := c.api.SuspendMicrovm(ctx, &lambdamicrovms.SuspendMicrovmInput{
		MicrovmIdentifier: aws.String(id),
	}); err != nil {
		return fmt.Errorf("awsvm: suspend microvm %s: %w", id, err)
	}
	return nil
}

// Resume restores a suspended box. Callers that are about to send a request can
// usually skip this entirely and let auto-resume handle it — Lambda holds the
// inbound request while restoring, so an explicit Resume only pays the latency
// earlier, it does not avoid it.
func (c *Client) Resume(ctx context.Context, id string) error {
	if _, err := c.api.ResumeMicrovm(ctx, &lambdamicrovms.ResumeMicrovmInput{
		MicrovmIdentifier: aws.String(id),
	}); err != nil {
		return fmt.Errorf("awsvm: resume microvm %s: %w", id, err)
	}
	return nil
}

// Terminate destroys the box and releases its quota.
func (c *Client) Terminate(ctx context.Context, id string) error {
	if _, err := c.api.TerminateMicrovm(ctx, &lambdamicrovms.TerminateMicrovmInput{
		MicrovmIdentifier: aws.String(id),
	}); err != nil {
		// Classified so callers can distinguish throttling — which is worth
		// retrying, because an abandoned terminate leaks the box's quota until
		// the 8h cap — from a terminal failure, which is not.
		return fmt.Errorf("awsvm: terminate microvm %s: %w", id, classifyLaunchError(err))
	}
	c.forgetToken(id)
	return nil
}

// List enumerates this account's MicroVMs in the region. Used for reconciling
// our view against reality — the analogue of the QEMU orphan reaper, since a VM
// we lose track of keeps consuming quota.
// listAttempts bounds retries on a single page of ListMicrovms.
//
// This call is throttled harder than the rest of the API on a busy account —
// observed failing on most passes with "exceeded maximum number of attempts, 3",
// the SDK's own default. The SDK gives up quickly and List is only ever called
// by background reconciliation, where nobody is waiting, so it is worth being
// considerably more patient than the default.
//
// It matters because List is the ONLY way the control plane sees a box that has
// no database row. A List that gives up does not degrade gracefully — it makes
// the orphan sweep a no-op, so leaked hosts bill and hold regional quota
// indefinitely while the sweep logs a failure nobody reads.
const listAttempts = 6

// listBackoff is the first delay between page retries, doubling thereafter. A
// var rather than a const so tests can exercise the full ladder without paying
// for it in wall-clock.
var listBackoff = 500 * time.Millisecond

// listPage fetches one page, retrying throttles with exponential backoff.
func (c *Client) listPage(ctx context.Context, next *string) (*lambdamicrovms.ListMicrovmsOutput, error) {
	backoff := listBackoff
	for attempt := 1; ; attempt++ {
		out, err := c.api.ListMicrovms(ctx, &lambdamicrovms.ListMicrovmsInput{NextToken: next})
		if err == nil {
			return out, nil
		}
		// Only throttling is worth retrying: a permissions or validation failure
		// answers the same way however long we wait.
		if !errors.Is(classifyLaunchError(err), ErrThrottled) || attempt >= listAttempts {
			return nil, err
		}
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		backoff *= 2
	}
}

func (c *Client) List(ctx context.Context) ([]Box, error) {
	var boxes []Box
	var next *string
	for {
		out, err := c.listPage(ctx, next)
		if err != nil {
			return nil, fmt.Errorf("awsvm: list microvms: %w", err)
		}
		for _, m := range out.Items {
			// Note: the list projection carries no endpoint — only Get does. A
			// caller that needs to talk to one of these has to fetch it.
			boxes = append(boxes, Box{
				ID:        aws.ToString(m.MicrovmId),
				ImageArn:  aws.ToString(m.ImageArn),
				State:     m.State,
				StartedAt: aws.ToTime(m.StartedAt),
			})
		}
		if out.NextToken == nil || aws.ToString(out.NextToken) == "" {
			return boxes, nil
		}
		next = out.NextToken
	}
}

// AuthToken returns a JWE for the box's agent port, minting one only when the
// cache is cold or stale. Tokens cap at 60 minutes, so any sandbox that lives
// longer will outlive several of them; refreshing at 75% of the lifetime keeps
// that churn off the request path.
func (c *Client) AuthToken(ctx context.Context, id string) (string, error) {
	now := time.Now()

	c.mu.Lock()
	if t, ok := c.tokens[id]; ok && now.Before(t.refreshAt) {
		v := t.value
		c.mu.Unlock()
		return v, nil
	}
	c.mu.Unlock()

	out, err := c.api.CreateMicrovmAuthToken(ctx, &lambdamicrovms.CreateMicrovmAuthTokenInput{
		MicrovmIdentifier:   aws.String(id),
		ExpirationInMinutes: aws.Int32(authTokenMaxMinutes),
		AllowedPorts: []types.PortSpecification{
			&types.PortSpecificationMemberPort{Value: c.cfg.AgentPort},
		},
	})
	if err != nil {
		return "", fmt.Errorf("awsvm: create auth token %s: %w", id, err)
	}
	value := out.AuthToken["X-aws-proxy-auth"]
	if value == "" {
		return "", fmt.Errorf("awsvm: auth token response for %s had no X-aws-proxy-auth", id)
	}

	life := time.Duration(authTokenMaxMinutes) * time.Minute
	c.mu.Lock()
	c.tokens[id] = &cachedToken{
		value:     value,
		refreshAt: now.Add(time.Duration(float64(life) * authTokenRefreshAt)),
		expiresAt: now.Add(life),
	}
	c.mu.Unlock()
	return value, nil
}

func (c *Client) forgetToken(id string) {
	c.mu.Lock()
	delete(c.tokens, id)
	c.mu.Unlock()
}

// AgentURL is the base URL for talking to the in-guest agent on a box. The
// endpoint the API hands back may or may not carry a scheme depending on the
// call, so normalise rather than trusting it.
func AgentURL(endpoint string) string {
	if endpoint == "" {
		return ""
	}
	if strings.HasPrefix(endpoint, "http://") || strings.HasPrefix(endpoint, "https://") {
		return endpoint
	}
	return "https://" + endpoint
}
