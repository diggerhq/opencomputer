# @opencomputer/create-start

Create a hello-world OpenComputer application:

```bash
npm create @opencomputer/start@latest my-agent
cd my-agent
npm install
npx opencomputer login
npm run dev
```

The generated project contains reactive agent definitions under
`opencomputer/` and a React application under `src/`. The first development
run lets you select an existing cloud project or create a new one.

Use `.` to initialize the current directory:

```bash
npm create @opencomputer/start@latest .
```
