# Autumn billing catalog

This directory defines the Autumn features and plans used to bill serverless
agent sessions. It contains no environment credentials.

The catalog is a complete declaration of the shared Autumn environment. It
preserves the existing standalone-sandbox compute, browser, disk, concurrency,
base-credit, model-spend, and top-up resources, and adds the fixed 2 GB / 1 vCPU
agent runtime meter plus the Pro and Max plans. Even when a rollout changes
only agent-session billing, existing resources must remain declared so the CLI
does not propose deleting or archiving them.

To create or reconcile a sandbox catalog:

```sh
npm ci
AUTUMN_SECRET_KEY=<sandbox-key> npm run push:sandbox
```

The command targets Autumn's sandbox environment by default. Review the diff
printed by the CLI before confirming it. Do not add the production flag when
configuring a development environment.

After pushing the catalog, configure the API edge with the same sandbox key and
the signing secret for a webhook targeting `/webhooks/autumn`.

To preview and reconcile the production catalog, use an Autumn production key
and keep the first push interactive:

```sh
npm ci
AUTUMN_PROD_SECRET_KEY=<production-key> npm run preview:prod
AUTUMN_PROD_SECRET_KEY=<production-key> npm run push:prod
```

The `--prod` flag selects Autumn's production environment. Review the complete
diff and verify the connected Stripe account before confirming the push. Do not
use `--yes` for the first production reconciliation. The deployed API edge uses
the same production key under its runtime secret name `AUTUMN_SECRET_KEY`.
