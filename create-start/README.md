# @opencomputer/create-start

Create a hello-world OpenComputer application:

```bash
npm create @opencomputer/start@latest my-agent
cd my-agent
npm install
npx opencomputer login
npm run dev
```

The initializer asks whether to create agent code only or include a React SPA.
The optional app imports its hooks from `@opencomputer/react`. A single
`npm run dev` syncs agents to Development (Cloud), prints the dashboard URL,
and starts Vite when the SPA is included. The first run lets you select an
existing cloud project or create a new one.

Use `.` to initialize the current directory:

```bash
npm create @opencomputer/start@latest .
```
