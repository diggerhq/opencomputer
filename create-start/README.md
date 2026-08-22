# @opencomputer/create-start

This package is a compatibility shim for the former npm initializer. New
projects should use the CLI directly:

```bash
npx @opencomputer/cli init my-agent
cd my-agent
npm install
npx --package @opencomputer/cli opencomputer login
npm run deploy -- --watch
```

The initializer creates a hello-world agent without a browser application.
`npm run deploy -- --watch` watches agent source, publishes changes to
Development (Cloud), and prints the dashboard URL.

Use `.` to initialize the current directory:

```bash
npx @opencomputer/cli init .
```
