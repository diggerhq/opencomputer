package commands

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/config"
	"github.com/spf13/cobra"
)

// feedback.now emitter (https://feedback.now). Any host that publishes
// /.well-known/agent-feedback.json is a valid target; OpenComputer's own API
// host is the default. Submission is anonymous unless --signing-key is given.
// These commands never touch the OpenComputer API key — the protocol is
// deliberately unauthenticated so third-party agents can report friction.

const (
	feedbackDiscoveryPath = "/.well-known/agent-feedback.json"
	feedbackTimeout       = 15 * time.Second
	feedbackEnvTarget     = "OC_FEEDBACK_TARGET"
	feedbackEnvSigningKey = "OC_FEEDBACK_SIGNING_KEY"
)

var feedbackCmd = &cobra.Command{
	Use:   "feedback",
	Short: "Report bugs and friction to a feedback.now-compatible API (OpenComputer by default)",
	Long: "Emit structured feedback using the feedback.now protocol.\n\n" +
		"Agents (or humans) hit a bug, docs mismatch, or friction in an API/CLI/SDK\n" +
		"and file it here without an account. The target host is discovered from\n" +
		"/.well-known/agent-feedback.json, so this works against any feedback.now\n" +
		"receiver, not just OpenComputer. Every submission returns a receipt ID you\n" +
		"can poll with `oc feedback receipt`.\n\n" +
		"Target selection: --target, else $" + feedbackEnvTarget + ", else the configured\n" +
		"OpenComputer API URL. Optional Ed25519 signing: --signing-key or\n" +
		"$" + feedbackEnvSigningKey + " (PEM file from `oc feedback keygen`).",
	Annotations: map[string]string{offlineCommandAnnotation: "true"},
}

var feedbackPolicyCmd = &cobra.Command{
	Use:         "policy",
	Short:       "Show the target's feedback.now discovery document and policy",
	Args:        cobra.NoArgs,
	Annotations: map[string]string{offlineCommandAnnotation: "true"},
	RunE: func(cmd *cobra.Command, _ []string) error {
		fc, err := newFeedbackClient(cmd)
		if err != nil {
			return err
		}
		disc, err := fc.discover(cmd.Context())
		if err != nil {
			return err
		}
		policyURL := fc.resolve(disc.PolicyURL, "/api/v1/policy")
		var policy map[string]any
		if err := fc.getJSON(cmd.Context(), policyURL, &policy); err != nil {
			return err
		}
		out := map[string]any{"target": fc.base.String(), "discovery": disc.raw, "policy": policy}
		if jsonOutput {
			return printer.PrintJSON(out)
		}
		fmt.Printf("Target:      %s\n", fc.base)
		fmt.Printf("Name:        %s\n", disc.Name)
		fmt.Printf("Policy:      %s\n", policyURL)
		fmt.Printf("Categories:  %s\n", strings.Join(stringList(policy["categories"]), ", "))
		fmt.Printf("Severities:  %s\n", strings.Join(stringList(policy["severity_levels"]), ", "))
		fmt.Printf("Evidence:    %s\n", strings.Join(stringList(policy["evidence_types"]), ", "))
		if auth, ok := disc.raw["auth"].(map[string]any); ok {
			fmt.Printf("Signing:     %v (optional)\n", auth["type"])
		}
		return nil
	},
}

var feedbackSubmitCmd = &cobra.Command{
	Use:   "submit",
	Short: "Submit a structured feedback report (bug, docs mismatch, friction, feature gap)",
	Example: "  oc feedback submit --surface 'POST /api/sandboxes' --category bug --severity high \\\n" +
		"    --title 'create returns 500 when template is missing' \\\n" +
		"    --summary 'Expected a 404 with a clear error' \\\n" +
		"    --evidence http_summary='{\"status\":500}' --evidence stderr_excerpt=@err.log\n" +
		"  oc feedback submit --target https://api.example.com --surface 'GET /v1/items' \\\n" +
		"    --category docs_mismatch --severity low --title 'docs say limit max is 500, API caps at 100'",
	Args:        cobra.NoArgs,
	Annotations: map[string]string{offlineCommandAnnotation: "true"},
	RunE: func(cmd *cobra.Command, _ []string) error {
		fc, err := newFeedbackClient(cmd)
		if err != nil {
			return err
		}
		f := cmd.Flags()
		title, _ := f.GetString("title")
		surface, _ := f.GetString("surface")
		category, _ := f.GetString("category")
		severity, _ := f.GetString("severity")
		if title == "" || surface == "" || category == "" || severity == "" {
			return fmt.Errorf("--title, --surface, --category and --severity are required")
		}
		summary, _ := f.GetString("summary")
		hypothesis, _ := f.GetString("hypothesis")
		repro, _ := f.GetString("reproducibility")
		confidence, _ := f.GetFloat64("confidence")
		kind, _ := f.GetString("kind")
		product, _ := f.GetString("product")
		evidenceFlags, _ := f.GetStringArray("evidence")
		evidence, err := parseEvidenceFlags(evidenceFlags)
		if err != nil {
			return err
		}

		signal := map[string]any{"category": category, "severity": severity, "confidence": confidence}
		if repro != "" {
			signal["reproducibility"] = repro
		}
		subject := map[string]any{"surface": surface, "domain": fc.domain(cmd)}
		if kind != "" {
			subject["kind"] = kind
		}
		if product != "" {
			subject["product"] = product
		}
		content := map[string]any{"title": title}
		if summary != "" {
			content["summary"] = summary
		}
		if hypothesis != "" {
			content["hypothesis"] = hypothesis
		}
		body := map[string]any{
			"reporter": fc.reporter(cmd),
			"subject":  subject,
			"signal":   signal,
			"content":  content,
		}
		if len(evidence) > 0 {
			body["evidence"] = evidence
		}

		disc, err := fc.discover(cmd.Context())
		if err != nil {
			return err
		}
		endpoint := fc.resolve(disc.endpoint("feedback", "submit"), "/api/v1/feedback")
		var resp map[string]any
		if err := fc.postJSON(cmd.Context(), endpoint, body, &resp); err != nil {
			return err
		}
		return fc.printReceipt(resp)
	},
}

var feedbackObserveCmd = &cobra.Command{
	Use:   "observe",
	Short: "Submit a lightweight observation (no title/evidence required)",
	Example: "  oc feedback observe --surface 'oc sandbox create' --category friction \\\n" +
		"    --summary '--template flag name differs from docs'",
	Args:        cobra.NoArgs,
	Annotations: map[string]string{offlineCommandAnnotation: "true"},
	RunE: func(cmd *cobra.Command, _ []string) error {
		fc, err := newFeedbackClient(cmd)
		if err != nil {
			return err
		}
		f := cmd.Flags()
		surface, _ := f.GetString("surface")
		if surface == "" {
			return fmt.Errorf("--surface is required")
		}
		rep := fc.reporter(cmd)
		body := map[string]any{
			"surface":       surface,
			"domain":        fc.domain(cmd),
			"agent_vendor":  rep["agent_vendor"],
			"agent_product": rep["agent_product"],
		}
		if v := rep["agent_version"]; v != "" {
			body["agent_version"] = v
		}
		for _, k := range []string{"category", "severity", "summary", "kind"} {
			if v, _ := f.GetString(k); v != "" {
				body[k] = v
			}
		}
		if f.Changed("confidence") {
			body["confidence"], _ = f.GetFloat64("confidence")
		}

		disc, err := fc.discover(cmd.Context())
		if err != nil {
			return err
		}
		endpoint := fc.resolve(disc.endpoint("observations", "submit"), "/api/v1/observations")
		var resp map[string]any
		if err := fc.postJSON(cmd.Context(), endpoint, body, &resp); err != nil {
			return err
		}
		return fc.printReceipt(resp)
	},
}

var feedbackReceiptCmd = &cobra.Command{
	Use:         "receipt <receipt-id>",
	Short:       "Poll a receipt to see whether the report was accepted, folded as a duplicate, or triaged",
	Args:        cobra.ExactArgs(1),
	Annotations: map[string]string{offlineCommandAnnotation: "true"},
	RunE: func(cmd *cobra.Command, args []string) error {
		fc, err := newFeedbackClient(cmd)
		if err != nil {
			return err
		}
		disc, err := fc.discover(cmd.Context())
		if err != nil {
			return err
		}
		tmpl := disc.endpoint("receipts", "get")
		if tmpl == "" {
			tmpl = "/api/v1/receipts/{id}"
		}
		u := fc.resolve(strings.Replace(tmpl, "{id}", url.PathEscape(args[0]), 1), "/api/v1/receipts/"+url.PathEscape(args[0]))
		var resp struct {
			Data map[string]any `json:"data"`
		}
		if err := fc.getJSON(cmd.Context(), u, &resp); err != nil {
			return err
		}
		if jsonOutput {
			return printer.PrintJSON(resp.Data)
		}
		rows := [][]string{}
		for _, k := range []string{"id", "status", "feedback_id", "observation_id", "feedback_status", "duplicate_of", "quality_score", "created_at", "updated_at"} {
			if v, ok := resp.Data[k]; ok && v != nil {
				rows = append(rows, []string{k, fmt.Sprint(v)})
			}
		}
		printer.Table([]string{"FIELD", "VALUE"}, rows)
		return nil
	},
}

var feedbackKeygenCmd = &cobra.Command{
	Use:   "keygen",
	Short: "Generate an Ed25519 signing key for agent identity (optional)",
	Long: "Writes a PKCS#8 PEM private key. Pass it via --signing-key or $" + feedbackEnvSigningKey +
		" so receivers can build a reputation for this agent across submissions.",
	Args:        cobra.NoArgs,
	Annotations: map[string]string{offlineCommandAnnotation: "true"},
	RunE: func(cmd *cobra.Command, _ []string) error {
		out, _ := cmd.Flags().GetString("out")
		if out == "" {
			return fmt.Errorf("--out is required")
		}
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		der, err := x509.MarshalPKCS8PrivateKey(priv)
		if err != nil {
			return err
		}
		if err := os.WriteFile(out, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
			return err
		}
		spki, err := x509.MarshalPKIXPublicKey(pub)
		if err != nil {
			return err
		}
		res := map[string]any{"path": out, "public_key": base64.StdEncoding.EncodeToString(spki)}
		if jsonOutput {
			return printer.PrintJSON(res)
		}
		fmt.Printf("Wrote %s\nPublic key (X-Agent-Key): %s\n", out, res["public_key"])
		return nil
	},
}

func init() {
	pf := feedbackCmd.PersistentFlags()
	pf.String("target", "", "Base URL of a feedback.now receiver (default: $"+feedbackEnvTarget+" or the OpenComputer API URL)")
	pf.String("signing-key", "", "PEM Ed25519 private key to sign requests (default: $"+feedbackEnvSigningKey+")")
	pf.String("agent-vendor", "opencomputer", "reporter.agent_vendor")
	pf.String("agent-product", "oc-cli", "reporter.agent_product")
	pf.String("agent-version", "", "reporter.agent_version (default: oc version)")
	pf.String("domain", "", "subject.domain (default: target host)")

	for _, c := range []*cobra.Command{feedbackSubmitCmd, feedbackObserveCmd} {
		c.Flags().String("surface", "", "What was being used, e.g. 'POST /api/sandboxes' or 'oc sandbox create'")
		c.Flags().String("category", "", "bug | docs_mismatch | friction | feature_gap | quality_degradation | other")
		c.Flags().String("severity", "", "critical | high | medium | low")
		c.Flags().Float64("confidence", 0.7, "0..1 confidence that this is a real issue")
		c.Flags().String("summary", "", "What happened vs. what was expected")
		c.Flags().String("kind", "", "api_endpoint | docs_page | cli_command | sdk_method | other")
	}
	feedbackSubmitCmd.Flags().String("title", "", "Short title (required)")
	feedbackSubmitCmd.Flags().String("hypothesis", "", "Suspected root cause")
	feedbackSubmitCmd.Flags().String("reproducibility", "", "always | sometimes | intermittent | once")
	feedbackSubmitCmd.Flags().String("product", "", "subject.product, e.g. 'typescript-sdk'")
	feedbackSubmitCmd.Flags().StringArray("evidence", nil, "type=content or type=@file (repeatable; types: http_summary, stderr_excerpt, repro_steps, log_excerpt, other)")

	feedbackKeygenCmd.Flags().String("out", "", "Where to write the PEM private key")

	feedbackCmd.AddCommand(feedbackPolicyCmd, feedbackSubmitCmd, feedbackObserveCmd, feedbackReceiptCmd, feedbackKeygenCmd)
}

// ── client ────────────────────────────────────────────────────────────────

type feedbackClient struct {
	base *url.URL
	http *http.Client
	key  ed25519.PrivateKey // nil → anonymous
}

type feedbackDiscovery struct {
	Name      string
	PolicyURL string
	raw       map[string]any
}

// endpoint returns endpoints.<group>.<op>.url from the discovery document, or "".
func (d *feedbackDiscovery) endpoint(group, op string) string {
	eps, _ := d.raw["endpoints"].(map[string]any)
	g, _ := eps[group].(map[string]any)
	o, _ := g[op].(map[string]any)
	u, _ := o["url"].(string)
	return u
}

func newFeedbackClient(cmd *cobra.Command) (*feedbackClient, error) {
	target, _ := cmd.Flags().GetString("target")
	if target == "" {
		target = os.Getenv(feedbackEnvTarget)
	}
	if target == "" {
		target = config.Load(cmd).APIURL
	}
	if !strings.Contains(target, "://") {
		target = "https://" + target
	}
	base, err := url.Parse(target)
	if err != nil || base.Host == "" {
		return nil, fmt.Errorf("invalid feedback target %q", target)
	}
	base.Path, base.RawQuery, base.Fragment = "", "", ""

	fc := &feedbackClient{base: base, http: &http.Client{Timeout: feedbackTimeout}}
	keyPath, _ := cmd.Flags().GetString("signing-key")
	if keyPath == "" {
		keyPath = os.Getenv(feedbackEnvSigningKey)
	}
	if keyPath != "" {
		fc.key, err = loadEd25519Key(keyPath)
		if err != nil {
			return nil, err
		}
	}
	return fc, nil
}

func loadEd25519Key(path string) (ed25519.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read signing key: %w", err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("signing key %s: not PEM", path)
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("signing key %s: %w", path, err)
	}
	priv, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("signing key %s: not an Ed25519 key", path)
	}
	return priv, nil
}

func (fc *feedbackClient) resolve(u, fallback string) string {
	if u == "" {
		u = fallback
	}
	ref, err := url.Parse(u)
	if err != nil {
		return fc.base.String() + fallback
	}
	return fc.base.ResolveReference(ref).String()
}

func (fc *feedbackClient) domain(cmd *cobra.Command) string {
	if d, _ := cmd.Flags().GetString("domain"); d != "" {
		return d
	}
	return fc.base.Hostname()
}

func (fc *feedbackClient) reporter(cmd *cobra.Command) map[string]string {
	vendor, _ := cmd.Flags().GetString("agent-vendor")
	product, _ := cmd.Flags().GetString("agent-product")
	version, _ := cmd.Flags().GetString("agent-version")
	if version == "" {
		version = Version
	}
	return map[string]string{"agent_vendor": vendor, "agent_product": product, "agent_version": version}
}

func (fc *feedbackClient) discover(ctx context.Context) (*feedbackDiscovery, error) {
	var raw map[string]any
	if err := fc.getJSON(ctx, fc.base.String()+feedbackDiscoveryPath, &raw); err != nil {
		return nil, fmt.Errorf("%s does not advertise feedback.now (%s): %w", fc.base.Host, feedbackDiscoveryPath, err)
	}
	d := &feedbackDiscovery{raw: raw}
	d.Name, _ = raw["name"].(string)
	d.PolicyURL, _ = raw["policy_url"].(string)
	return d, nil
}

func (fc *feedbackClient) getJSON(ctx context.Context, u string, out any) error {
	return fc.do(ctx, http.MethodGet, u, nil, out)
}

func (fc *feedbackClient) postJSON(ctx context.Context, u string, body any, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return fc.do(ctx, http.MethodPost, u, b, out)
}

// feedbackErrorMessage flattens the receiver's error envelope, including
// feedback.now's per-field validation errors, into one line.
func feedbackErrorMessage(status int, data []byte) string {
	var body map[string]any
	_ = json.Unmarshal(data, &body)
	msg, _ := body["error"].(string)
	if msg == "" {
		msg = http.StatusText(status)
	}
	if errs, ok := body["errors"].([]any); ok && len(errs) > 0 {
		parts := make([]string, 0, len(errs))
		for _, fe := range errs {
			m, _ := fe.(map[string]any)
			parts = append(parts, fmt.Sprintf("%v: %v", m["field"], m["message"]))
		}
		msg += " (" + strings.Join(parts, "; ") + ")"
	}
	return msg
}

func (fc *feedbackClient) do(ctx context.Context, method, u string, body []byte, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "oc-cli/"+Version)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if fc.key != nil {
		fc.sign(req, body)
	}
	resp, err := fc.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return &client.APIError{StatusCode: resp.StatusCode, Message: feedbackErrorMessage(resp.StatusCode, data)}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode response from %s: %w", u, err)
	}
	return nil
}

// sign adds the feedback.now Ed25519 headers. Payload per spec:
// timestamp\nMETHOD\npath\nsha256hex(body).
func (fc *feedbackClient) sign(req *http.Request, body []byte) {
	ts := time.Now().UTC().Format(time.RFC3339)
	sum := sha256.Sum256(body)
	payload := strings.Join([]string{ts, req.Method, req.URL.Path, hex.EncodeToString(sum[:])}, "\n")
	sig := ed25519.Sign(fc.key, []byte(payload))
	spki, err := x509.MarshalPKIXPublicKey(fc.key.Public())
	if err != nil {
		return
	}
	req.Header.Set("X-Agent-Key", base64.StdEncoding.EncodeToString(spki))
	req.Header.Set("X-Agent-Signature", base64.StdEncoding.EncodeToString(sig))
	req.Header.Set("X-Agent-Timestamp", ts)
}

func (fc *feedbackClient) printReceipt(resp map[string]any) error {
	receipt, _ := resp["receipt"].(map[string]any)
	if jsonOutput {
		return printer.PrintJSON(resp)
	}
	status, _ := receipt["status"].(string)
	fmt.Printf("Receipt:  %v\nStatus:   %s\n", receipt["id"], status)
	if v, ok := receipt["feedback_id"]; ok && v != nil {
		fmt.Printf("Feedback: %v\n", v)
	}
	if v, ok := receipt["observation_id"]; ok && v != nil {
		fmt.Printf("Observation: %v\n", v)
	}
	if v, ok := receipt["duplicate_of"]; ok && v != nil {
		fmt.Printf("Folded into existing report %v\n", v)
	}
	fmt.Printf("Poll with: oc feedback receipt %v --target %s\n", receipt["id"], fc.base)
	return nil
}

// parseEvidenceFlags turns type=content / type=@file into evidence objects.
func parseEvidenceFlags(flags []string) ([]map[string]any, error) {
	out := make([]map[string]any, 0, len(flags))
	for _, f := range flags {
		typ, val, ok := strings.Cut(f, "=")
		if !ok || typ == "" {
			return nil, fmt.Errorf("--evidence %q: expected type=content or type=@file", f)
		}
		if strings.HasPrefix(val, "@") {
			b, err := os.ReadFile(val[1:])
			if err != nil {
				return nil, fmt.Errorf("--evidence %s: %w", typ, err)
			}
			val = string(b)
		}
		out = append(out, map[string]any{"type": typ, "content": val})
	}
	return out, nil
}

func stringList(v any) []string {
	arr, _ := v.([]any)
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		out = append(out, fmt.Sprint(x))
	}
	return out
}
