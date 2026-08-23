# Autumn billing catalog

This directory defines the Autumn features and plans expected by
OpenComputer's usage-billing code. It contains no environment credentials.

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
