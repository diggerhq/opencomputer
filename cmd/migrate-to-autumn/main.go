// Command migrate-to-autumn moves a legacy org onto Autumn billing.
//
// Per org it: creates the Autumn customer (id = org UUID → base plan + $5),
// carries the org's current legacy balance over to Autumn, flips
// billing_provider to 'autumn' in BOTH D1 (edge) and cell-PG, and projects
// is_halted/max_concurrent. It NEVER enables auto top-up — auto-recharge is
// opt-in only (ROSCA, 15 U.S.C. § 8403: express informed consent required).
//
// Flip ordering avoids ever having both billers live for one org:
//   →autumn: D1 first (stops the legacy edge DO debit), then cell-PG (starts the
//            Autumn reporter). During the gap only the legacy cell deduction
//            runs — never a double-charge.
//   →legacy: cell-PG first (stops the Autumn reporter), then D1. Symmetric.
//
// Defaults to free orgs only and --dry-run. PRO orgs hold an active Stripe
// subscription + saved card — moving them to prepaid requires canceling that
// subscription, confirming card re-use, and customer notification; do those
// deliberately, not in a bulk sweep (gated behind --include-pro).
//
// Run (single org):
//
//	OPENSANDBOX_DATABASE_URL=... AUTUMN_SECRET_KEY=... \
//	OPENSANDBOX_CF_EDGE_BASE_URL=... OPENSANDBOX_CF_EVENT_SECRET=... \
//	  go run ./cmd/migrate-to-autumn --org <uuid> --live
package main

import (
	"context"
	"flag"
	"log"
	"os"

	"github.com/google/uuid"

	"github.com/opensandbox/opensandbox/internal/billing/autumn"
	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/edgeclient"
)

func main() {
	orgFlag := flag.String("org", "", "org UUID to migrate (required)")
	revert := flag.Bool("revert", false, "flip back to legacy instead of migrating to autumn")
	live := flag.Bool("live", false, "actually mutate; without it the run is a dry-run")
	includePro := flag.Bool("include-pro", false, "allow migrating pro orgs (they have Stripe subs — handle their subscription + card + notice separately)")
	minGrant := flag.Float64("min-grant", 0, "floor the carried-over Autumn balance at this many dollars")
	flag.Parse()

	if *orgFlag == "" {
		log.Fatal("--org is required")
	}
	orgID, err := uuid.Parse(*orgFlag)
	if err != nil {
		log.Fatalf("bad --org: %v", err)
	}
	dryRun := !*live

	dbURL := mustEnv("OPENSANDBOX_DATABASE_URL")
	autumnKey := mustEnv("AUTUMN_SECRET_KEY")
	edgeURL := mustEnv("OPENSANDBOX_CF_EDGE_BASE_URL")
	edgeSecret := mustEnv("OPENSANDBOX_CF_EVENT_SECRET")

	ctx := context.Background()
	store, err := db.NewStore(ctx, dbURL)
	if err != nil {
		log.Fatalf("connect db: %v", err)
	}
	defer store.Close()

	var aut autumn.Client = autumn.New(autumnKey)
	if base := os.Getenv("AUTUMN_BASE_URL"); base != "" {
		aut = autumn.New(autumnKey, autumn.WithBaseURL(base))
	}
	edge := edgeclient.New(edgeURL, edgeSecret)

	org, err := store.GetOrg(ctx, orgID)
	if err != nil {
		log.Fatalf("get org %s: %v", orgID, err)
	}

	if *revert {
		revertOrg(ctx, store, edge, org, dryRun)
		return
	}
	migrateOrg(ctx, store, aut, edge, org, *includePro, *minGrant, dryRun)
}

func migrateOrg(ctx context.Context, store *db.Store, aut autumn.Client, edge *edgeclient.Client, org *db.Org, includePro bool, minGrant float64, dryRun bool) {
	if org.BillingProvider == "autumn" {
		log.Printf("org %s already on autumn — nothing to do", org.ID)
		return
	}
	if org.Plan == "pro" && !includePro {
		log.Fatalf("org %s is pro (has a Stripe subscription) — migrate it deliberately with --include-pro after handling the subscription + card + notice", org.ID)
	}

	balance := float64(org.FreeCreditsRemainingCents) / 100.0
	if balance < minGrant {
		balance = minGrant
	}
	log.Printf("MIGRATE org=%s plan=%s carry_balance=$%.2f max_concurrent=%d (dry_run=%v)",
		org.ID, org.Plan, balance, org.MaxConcurrentSandboxes, dryRun)
	if org.MaxConcurrentSandboxes > autumn.DefaultConcurrency {
		log.Printf("  ⚠ org has max_concurrent=%d (> base %d) — attach the matching Autumn concurrency plan as a comp MANUALLY; this tool does not (comp API unconfirmed)",
			org.MaxConcurrentSandboxes, autumn.DefaultConcurrency)
	}

	if dryRun {
		log.Printf("  [dry-run] would: create customer, set balance $%.2f, flip D1→autumn (+project), flip cell-PG→autumn. auto-topup left OFF.", balance)
		return
	}

	// 1. Autumn customer (idempotent) + carry balance over. Auto top-up left OFF.
	//    Link the existing Stripe customer (if any) so a card-on-file org keeps
	//    its saved payment method — confirmed live that POST /customers adopts
	//    an existing stripe_id.
	cp := autumn.CreateCustomerParams{ID: org.ID.String(), Name: org.Name}
	if org.StripeCustomerID != nil {
		cp.StripeID = *org.StripeCustomerID
	}
	if _, err := aut.CreateCustomer(ctx, cp); err != nil {
		log.Fatalf("  create customer: %v", err)
	}
	if err := aut.SetCreditBalance(ctx, org.ID.String(), balance); err != nil {
		log.Fatalf("  set balance: %v", err)
	}
	// 2. Flip D1 first (stops legacy edge DO debit + projects is_halted/max_concurrent).
	if err := edge.SetAutumnProvider(ctx, org.ID, "autumn"); err != nil {
		log.Fatalf("  flip D1: %v", err)
	}
	// 3. Flip cell-PG (starts the Autumn reporter; stops the legacy cell deduction).
	if err := store.SetBillingProvider(ctx, org.ID, "autumn"); err != nil {
		log.Fatalf("  flip cell-PG: %v", err)
	}
	log.Printf("  ✓ migrated org %s to autumn (balance $%.2f, auto-topup OFF)", org.ID, balance)
}

func revertOrg(ctx context.Context, store *db.Store, edge *edgeclient.Client, org *db.Org, dryRun bool) {
	if org.BillingProvider != "autumn" {
		log.Printf("org %s is not on autumn — nothing to revert", org.ID)
		return
	}
	log.Printf("REVERT org=%s → legacy (dry_run=%v)", org.ID, dryRun)
	if dryRun {
		log.Printf("  [dry-run] would: flip cell-PG→legacy, then D1→legacy")
		return
	}
	// cell-PG first (stops the Autumn reporter before the legacy edge debit resumes).
	if err := store.SetBillingProvider(ctx, org.ID, "legacy"); err != nil {
		log.Fatalf("  flip cell-PG: %v", err)
	}
	if err := edge.SetAutumnProvider(ctx, org.ID, "legacy"); err != nil {
		log.Fatalf("  flip D1: %v", err)
	}
	log.Printf("  ✓ reverted org %s to legacy", org.ID)
}

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		log.Fatalf("%s is required", k)
	}
	return v
}
