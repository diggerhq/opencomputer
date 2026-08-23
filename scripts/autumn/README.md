# Autumn billing catalog

This directory defines the Autumn features and plans used to bill serverless
agent sessions. It contains no environment credentials.

The catalog currently covers the shared credit balance, the fixed 2 GB / 1
vCPU agent runtime meter, managed model spend, Usage/Pro/Max plans, and one-off
top-ups. Raw standalone-sandbox products are intentionally outside this
catalog and have a separate rollout lifecycle.

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
