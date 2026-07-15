package commands

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/fluebuild"
	"github.com/spf13/cobra"
)

const offlineCommandAnnotation = "opencomputer.dev/offline"

var agentBuildCmd = &cobra.Command{
	Use:   "build",
	Short: "Build a Flue deployment artifact without deploying it",
	Long: "Validate and build a Flue repository into bundle.tgz and deployment.json.\n\n" +
		"This command does not fetch source, install dependencies, authenticate, upload,\n" +
		"or deploy. Run npm ci before a full build. --check-only validates source and\n" +
		"configuration without executing repository code or requiring node_modules.",
	Example: "  oc agent build --dir . --target cloudflare --output /tmp/flue-build --json\n" +
		"  oc agent build --dir . --check-only --json",
	Args:        cobra.NoArgs,
	Annotations: map[string]string{offlineCommandAnnotation: "true"},
	RunE: func(cmd *cobra.Command, _ []string) error {
		dir, _ := cmd.Flags().GetString("dir")
		target, _ := cmd.Flags().GetString("target")
		output, _ := cmd.Flags().GetString("output")
		checkOnly, _ := cmd.Flags().GetBool("check-only")
		if !checkOnly && output == "" {
			return fmt.Errorf("--output is required unless --check-only is set")
		}

		result, err := fluebuild.Build(cmd.Context(), fluebuild.Options{
			Dir:            dir,
			Target:         target,
			OutputDir:      output,
			BuilderVersion: Version,
			CheckOnly:      checkOnly,
		})
		if err != nil {
			return err
		}
		if jsonOutput {
			encoder := json.NewEncoder(os.Stdout)
			encoder.SetEscapeHTML(false)
			return encoder.Encode(result.Deployment)
		}
		if checkOnly {
			fmt.Printf("Valid Flue entrypoint %s (%s, %s/%s)\n",
				result.Deployment.Flue.Entrypoint,
				result.Deployment.Model,
				result.Deployment.Runtime.Family,
				result.Deployment.Runtime.Type)
			return nil
		}
		fmt.Printf("Built %s and %s in %s (%s, %d bytes)\n",
			fluebuild.BundleFilename,
			fluebuild.DeploymentFilename,
			output,
			result.Deployment.Bundle.Digest,
			result.Deployment.Bundle.SizeBytes)
		return nil
	},
}

func init() {
	agentBuildCmd.Flags().String("dir", ".", "Flue repository root")
	agentBuildCmd.Flags().String("target", fluebuild.TargetCloudflare, "Build target")
	agentBuildCmd.Flags().String("output", "", "Directory for bundle.tgz and deployment.json")
	agentBuildCmd.Flags().Bool("check-only", false, "Validate without executing repository code")
}
