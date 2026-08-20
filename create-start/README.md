# @opencomputer/create-start

Create a hello-world OpenComputer application:

```bash
npm create @opencomputer/start@latest my-agent
cd my-agent
npm install
npx --package @opencomputer/cli opencomputer login
npm run dev
```

This package is the naming shim npm resolves for the command above. The
interactive initializer is shipped by the same-version `@opencomputer/cli`
package. It asks whether to create agent code only or include a React SPA. A
single `npm run dev` syncs agents to Development (Cloud), prints the dashboard
URL, and starts Vite when the SPA is included.

Use `.` to initialize the current directory:

```bash
npm create @opencomputer/start@latest .
```
