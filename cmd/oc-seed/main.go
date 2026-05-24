// oc-seed is a bootstrap CLI that idempotently creates an org + API key
// against a fresh OpenComputer database. It is intended to be run once on
// first deploy (e.g. as a one-shot ECS task or a manual command after
// `terraform apply`) so the operator has working credentials without having
// to hand-craft SQL.
//
// Usage:
//
//	oc-seed \
//	  --database-url postgres://user:pass@host:5432/opensandbox \
//	  --org-slug bootstrap \
//	  --org-name "Bootstrap Org" \
//	  --key-name "bootstrap-admin"
//
// Behavior:
//   - If the org with --org-slug exists, it is reused (idempotent).
//   - A NEW random API key is always generated; the plaintext is printed to
//     stdout ONCE. The hash is stored in the api_keys table.
//   - Exits 0 on success, 1 on any failure.
//
// The key plaintext is the ONLY way to retrieve it later; we store only the
// hash. Capture the output of this command immediately and put it into a
// secret store (AWS Secrets Manager, Vault, etc.).
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/opensandbox/opensandbox/internal/db"
)

func main() {
	var (
		databaseURL = flag.String("database-url", os.Getenv("OPENSANDBOX_DATABASE_URL"),
			"Postgres DSN (default: $OPENSANDBOX_DATABASE_URL or $DATABASE_URL)")
		orgSlug = flag.String("org-slug", "bootstrap",
			"Slug for the bootstrap org (reused if it already exists)")
		orgName = flag.String("org-name", "Bootstrap Org",
			"Display name for the bootstrap org (only used when creating)")
		keyName = flag.String("key-name", "bootstrap-admin",
			"Name to attach to the generated API key (visible in /api/dashboard/api-keys)")
		runMigrate = flag.Bool("migrate", true,
			"Run `Migrate()` against the DB before seeding (idempotent, safe to leave on)")
	)
	flag.Parse()

	if *databaseURL == "" {
		*databaseURL = os.Getenv("DATABASE_URL")
	}
	if *databaseURL == "" {
		die("--database-url is required (or set OPENSANDBOX_DATABASE_URL / DATABASE_URL)")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	store, err := db.NewStore(ctx, *databaseURL)
	if err != nil {
		die("failed to connect to database: %v", err)
	}
	defer store.Close()

	if *runMigrate {
		if err := store.Migrate(ctx); err != nil {
			die("failed to run migrations: %v", err)
		}
	}

	// 1. Reuse-or-create the org.
	org, err := store.GetOrgBySlug(ctx, *orgSlug)
	if err != nil {
		// The store returns a wrapped pgx ErrNoRows-style error. If anything
		// other than "not found", surface it. Otherwise we'll create.
		if !isNotFound(err) {
			die("failed to look up org by slug %q: %v", *orgSlug, err)
		}
		org, err = store.CreateOrg(ctx, *orgName, *orgSlug)
		if err != nil {
			die("failed to create org: %v", err)
		}
		fmt.Fprintf(os.Stderr, "[seed] created org %s (id=%s)\n", *orgSlug, org.ID)
	} else {
		fmt.Fprintf(os.Stderr, "[seed] reusing existing org %s (id=%s)\n", *orgSlug, org.ID)
	}

	// 2. Generate a fresh API key.
	plaintext, prefix, err := generateAPIKey()
	if err != nil {
		die("failed to generate API key: %v", err)
	}
	hash := db.HashAPIKey(plaintext)

	// 3. Insert. No createdBy — bootstrap key has no associated user.
	apiKey, err := store.CreateAPIKey(ctx, org.ID, nil, hash, prefix, *keyName, []string{"sandbox:*", "snapshot:*"})
	if err != nil {
		die("failed to create API key: %v", err)
	}

	// 4. Print credentials. Two streams: stderr for diagnostics, stdout for the
	// machine-parseable creds block (so you can redirect stdout to a secret
	// without stderr noise).
	fmt.Fprintf(os.Stderr, "[seed] created API key %s (id=%s, prefix=%s)\n", *keyName, apiKey.ID, prefix)
	fmt.Fprintf(os.Stderr, "[seed] capture the plaintext below — it is not retrievable again.\n")
	fmt.Println("=== OPENCOMPUTER BOOTSTRAP CREDENTIALS ===")
	fmt.Printf("ORG_ID=%s\n", org.ID)
	fmt.Printf("ORG_SLUG=%s\n", org.Slug)
	fmt.Printf("API_KEY=%s\n", plaintext)
	fmt.Printf("API_KEY_PREFIX=%s\n", prefix)
	fmt.Println("=== END BOOTSTRAP CREDENTIALS ===")
}

// generateAPIKey returns (plaintext, prefix, error). Plaintext format:
//
//	ocp_<48-hex-chars>
//
// Prefix is the first 8 chars of the hex (without the `ocp_` marker) — matches
// the convention used elsewhere in the codebase (visible in the dashboard).
func generateAPIKey() (plaintext, prefix string, err error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	hexStr := hex.EncodeToString(buf)
	return "ocp_" + hexStr, hexStr[:8], nil
}

// isNotFound returns true if the error looks like "no rows" from the store.
func isNotFound(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "no rows") ||
		strings.Contains(msg, "not found") ||
		errors.Is(err, errNotFound)
}

// sentinel for test usage; real errors come from pgx/store wrapping
var errNotFound = errors.New("not found")

func die(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "oc-seed: "+format+"\n", args...)
	os.Exit(1)
}
