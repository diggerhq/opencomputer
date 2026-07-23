package commands

// LangGraph deploy flow — the standalone langgraph runtime (model A: the graph runs
// inside a self-hosting Worker + one Durable Object per session). Mirrors the flue
// flow (build client-side, stage the bundle in R2 via presigned PUT, POST a byte-free
// deployment) but is independent of flue: the bundle comes from the project's own
// wrangler, and the deployment carries `langgraph_*` fields. The server registers the
// `langgraph` family, then hosts the Worker + binds its session DO like any WfP Worker.

import (
	"fmt"
	"time"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/langgraphbuild"
	"github.com/spf13/cobra"
)

func deployLangGraph(cmd *cobra.Command, sc *client.Client, dir string, m *manifest, noActivate bool) error {
	// 1. Resolve the target agent first (create with runtime=langgraph + no prompt if
	//    new) so a runtime-family mismatch fails fast, before the (slow) bundle.
	id, err := resolveDeployAgentFamily(cmd, sc, m, "langgraph")
	if err != nil {
		return err
	}
	// 2. Persist [vars] before enqueueing so the off-host host can't race ahead with
	//    stale bindings (secrets stay CLI/API-only, resolved by that same host). Only when
	//    the manifest declares vars — the config endpoint has no state for a fresh agent.
	if len(m.Vars) > 0 {
		if err := syncManifestVars(cmd, sc, id, m); err != nil {
			return err
		}
	}

	// 3. Bundle the project with its own wrangler → tar.gz + descriptor + digest.
	art, err := langgraphbuild.Build(cmd.Context(), dir)
	if err != nil {
		return err
	}

	// 4. Upload: presigned PUT to R2 (the API host never sees the bytes).
	if err := uploadArtifact(cmd.Context(), sc, id, art.Digest, art.Bundle); err != nil {
		return err
	}

	// 5. Byte-free deployment referencing the R2 bundle + the strict descriptor.
	rt := m.Runtime.Type
	if rt == "" {
		rt = "default"
	}
	// Post the artifact under the langgraph family field names. The server routes runtime=langgraph
	// through the same generic self-hosting WfP-DO deploy pipeline flue uses, normalizing
	// langgraph_*/flue_* to one enqueue — so these are the honest langgraph wire fields, not a masquerade.
	input := map[string]interface{}{
		"type":                    "inline",
		"model":                   m.Model,
		"runtime":                 map[string]string{"type": rt},
		"langgraph_bundle_digest": art.Digest,
		"langgraph_wrangler":      art.Wrangler,
		"langgraph_entrypoint":    art.Entrypoint, // the session Durable Object class = admit address
	}
	body := map[string]interface{}{"input": input, "activate": !noActivate}
	if idem, _ := cmd.Flags().GetString("idempotency-key"); idem != "" {
		body["idempotency_key"] = idem
	}
	var env DeploymentEnvelope
	if err := sc.Post(cmd.Context(), "/v3/agents/"+id+"/deployments", body, &env); err != nil {
		return err
	}
	d := env.Deployment

	// 6. Poll to terminal while the off-host host uploads + finalizes.
	if !terminalState(d.State) && d.State != "" {
		to, _ := cmd.Flags().GetInt("timeout")
		d, err = pollDeployment(cmd, sc, id, d.ID, time.Duration(to)*time.Second)
		if err != nil {
			return err
		}
	}
	if d.State == "failed" {
		printer.Print(d, func() { fmt.Printf("Deploy failed: %s\n", deployFailMsg(d)) })
		return &ExitError{Code: 1}
	}
	printer.Print(d, func() {
		n := revisionNumber(cmd, sc, id, d.RevisionID)
		status := "staged"
		if d.Active {
			status = "active"
		}
		fmt.Printf("Deployed revision %d — %s (%s)\n", n, status, shortDigest(art.Digest))
	})
	return nil
}

// resolveDeployAgentFamily picks the agent a code-runtime deploy targets: --agent >
// manifest [agent].id > ensure-by-name (creating an agent of the given family, no
// prompt, if absent). Generalizes resolveDeployAgent (which is flue-specific).
func resolveDeployAgentFamily(cmd *cobra.Command, sc *client.Client, m *manifest, family string) (string, error) {
	if explicit, _ := cmd.Flags().GetString("agent"); explicit != "" {
		return resolveRef(cmd, sc, explicit)
	}
	if m.Agent.ID != "" {
		return m.Agent.ID, nil
	}
	id, _, err := ensureAgentByName(cmd, sc, m.Name, "", m.Model, family)
	return id, err
}
