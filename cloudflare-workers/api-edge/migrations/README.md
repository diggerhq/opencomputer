# D1 migrations

Wrangler applies SQL files in this directory and records them in the D1
`d1_migrations` table.

Schema snapshots live outside this directory in `../schema-snapshots/`, so they
are never applied by Wrangler migrations.

## Existing databases

Do not apply `../schema-snapshots/current_schema.sql` to the existing prod database.
Prod migrations are listed and applied from the private deploy repository
(`diggerhq/opencomputer-deploy`, `d1-migrations.yml`), which holds the prod
config. A prod deploy there fails while a migration is pending, except purely
additive ones, which it applies first.

## Fresh databases

For a brand-new D1 database, apply the snapshot once before running Wrangler
migrations:

```bash
cd cloudflare-workers/api-edge
npx wrangler d1 execute <database-name> --remote -c <wrangler-config> --file schema-snapshots/current_schema.sql
npx wrangler d1 migrations apply <database-name> --remote -c <wrangler-config>
```

## Future schema changes

Create one numbered migration per schema change:

```bash
cd cloudflare-workers/api-edge
npx wrangler d1 migrations create opencomputer-prod add_example_column
```

Review the generated SQL before merging. Migrations should be safe to run before
the matching Worker deploy because CI applies migrations first.
