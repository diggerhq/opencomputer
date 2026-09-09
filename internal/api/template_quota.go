package api

// template_quota.go — what stops custom templates from exhausting the account.
//
// THE CONSTRAINT, measured rather than assumed: AWS caps this account at 100
// MicroVM images (Service Quotas, service-code `lambda`, L-942E56BE). At the
// time of writing 35 were in use and only 6 of them were the sandbox fleet's —
// 16 belonged to `managed-agents-runtime-*`, a different workload sharing the
// account. So "one image per template" runs out after ~65 templates, and
// exhausting it does not merely stop new templates: it blocks rebuilding the
// POOL image that every sandbox depends on, and blocks the other workload's
// deploys.
//
// Three mechanisms keep that from happening, in order of how much they buy:
//
//  1. DEDUPE. Images scale with DISTINCT templates, not with customers.
//  2. PER-ORG CAP. One org cannot consume the account.
//  3. GC. Templates nobody launches stop holding a slot.
//
// A quota increase to 1000 has been requested; none of the above stops being
// necessary if it is granted, because all three are about the SHAPE of the
// growth, not the ceiling.

import (
	"fmt"
	"regexp"
	"strings"
)

const (
	// maxImageTemplatesPerOrg caps how many image slots one org can hold.
	//
	// Deliberately well below the account ceiling: with the cap at 10 and a
	// 1000-image quota, it takes 100 orgs all using templates heavily to reach
	// the limit, and no single customer can starve the fleet by scripting
	// template creation. Raise per-org rather than removing the cap.
	maxImageTemplatesPerOrg = 10

	// templateImagePrefix marks an image as ours, and as a customer template.
	//
	// Load-bearing for shared-account safety: deploy/microvm/publish.sh is
	// careful never to enumerate or touch an image it did not create, and the
	// same rule applies here. Anything without this prefix belongs to the pool,
	// to managed-agents, or to someone else, and must never be deleted by this
	// code path.
	templateImagePrefix = "osb-tpl-"
)

// Tags applied to every template image. Ownership is expressed in tags as well
// as in the name because a name is a weak assertion — tags survive rename and
// are queryable when reconciling what we own against what exists.
const (
	tagManagedBy = "osb:managed-by"
	tagOrgID     = "osb:org-id"
	tagKind      = "osb:kind"
)

// templateImageName derives the AWS image name for an org's template.
//
// Content-addressed by the manifest hash, which is what makes DEDUPE work: the
// same manifest yields the same name, so a rebuild reuses the image slot rather
// than taking another. The org prefix keeps two orgs' identical manifests in
// separate images — see FindMicrovmImageTemplateByTag for why that is the
// conservative choice.
//
// Truncated because AWS image names are bounded and a full pair of SHA-256
// hexes is 128 characters. 8 org + 16 manifest characters is 96 bits of
// manifest hash, which is far past collision concern for a per-org namespace.
func templateImageName(orgID, manifestHash string) string {
	org := sanitizeNameComponent(orgID)
	if len(org) > 8 {
		org = org[:8]
	}
	h := sanitizeNameComponent(manifestHash)
	if len(h) > 16 {
		h = h[:16]
	}
	return templateImagePrefix + org + "-" + h
}

var nameComponentInvalid = regexp.MustCompile(`[^a-zA-Z0-9]`)

func sanitizeNameComponent(s string) string {
	return nameComponentInvalid.ReplaceAllString(s, "")
}

// templateImageTags returns the ownership tags for a template image.
func templateImageTags(orgID string) map[string]string {
	return map[string]string{
		tagManagedBy: "opensandbox",
		tagOrgID:     orgID,
		tagKind:      "custom-template",
	}
}

// isOurTemplateImage reports whether an image ARN or name is a customer
// template this code may delete.
//
// The guard on every destructive path. Called with an ARN read back from our
// own registry, it is belt-and-braces; called with anything else it is the only
// thing standing between a GC pass and another workload's images.
func isOurTemplateImage(arnOrName string) bool {
	if arnOrName == "" {
		return false
	}
	name := arnOrName
	if i := strings.LastIndex(name, ":"); i >= 0 {
		name = name[i+1:]
	}
	return strings.HasPrefix(name, templateImagePrefix)
}

// ErrTemplateQuotaExceeded is returned when an org is at its image-template cap.
var ErrTemplateQuotaExceeded = fmt.Errorf("template image quota exceeded")

// checkTemplateQuota reports whether an org may take another image slot.
//
// Returns a message naming the cap and what to do about it. A bare "quota
// exceeded" leaves a customer with no idea whether to wait, delete something,
// or ask for a raise.
func checkTemplateQuota(current int) error {
	if current < maxImageTemplatesPerOrg {
		return nil
	}
	return fmt.Errorf("%w: this org holds %d of %d custom template images; delete an unused template before building another",
		ErrTemplateQuotaExceeded, current, maxImageTemplatesPerOrg)
}
