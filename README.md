<!--
README outline for the @computer OSS launch. Headings and a one-line goal per
section only; copy to be written once the shape is agreed.
Scope: @computer only. Serverless Agents and the sandbox platform get at most a
link in "Docs".
-->

<p align="center">
  <img src="docs/images/readme-banner.svg" alt="OpenComputer" width="100%">
</p>

# OpenComputer: Open-source Devin alternative

**3x faster than Devin.**

_Goal: in one glance the reader gets the tagline, the speed claim with its source, and the Cloud button._

TODO: logo (light/dark), badges (license, release, Slack community).

TODO: link "3x faster" to the published benchmark (speedbench runs computer vs devin; results not yet in its README).

<p align="center">
  <a href="https://app.opencomputer.dev"><img alt="Try OpenComputer in Slack" src="https://img.shields.io/badge/Try_OpenComputer_in_Slack-4A154B?style=for-the-badge&logo=slack&logoColor=white"></a>
</p>

TODO: secondary links under the button: Docs · Self-host · Community.

From launch post: "the open source and self-hostable alternative to Devin", open source "from the compute layer all the way to the top".

## See it work

_Goal: the reader sees a real thread in under 10 seconds: mention, live progress, steering mid-turn, PR opened._

<p align="center">
  <img src="docs/images/readme-slack.gif" alt="A Slack thread: someone mentions @Computer, and it replies in the thread within seconds" width="70%">
</p>

TODO: caption on how fast it answers in Slack. Still wanted: a longer thread showing live progress, steering mid-turn and a PR opened.

<p align="center">
  <img src="docs/images/readme-vs-local.gif" alt="Side-by-side race on the same task: Claude Code on a laptop against @computer in the cloud; @computer finishes in 32.0s, local in 36.2s" width="100%">
</p>

TODO: caption: "As fast as Claude Code on your own machine." Same task, same model, real time.

From launch post: it also wants GIFs that show the speed; make one set for both.

## What it does

_Goal: 4–6 bullets of what makes it different, each one concrete._

TODO: candidates: works live in the thread and you can steer it mid-turn; its own computer per task; work leaves through git as a PR; runs Claude Code or Codex on your own plan; parallel threads; Slack, GitHub and Linear built in.

From launch post, candidate bullets:
- Open source end to end, from the compute layer up; run it entirely in your own cloud account.
- Fast because the agent and its computer share one durable VM: no network round trip per `bash` or `grep`, no S3-backed disk. "Feels as fast as local Claude Code."
- Real QEMU VMs with local disks, because disk speed matters for code work.
- One VM per team with isolated sessions on top: repos, packages and caches are already warm, and one VM runs hundreds of sessions in parallel.
- Stateless on a persistent disk: each session is backed up to a repo after every turn, so sessions move between VMs and the fleet scales out.
- Multiplayer: the whole team starts and follows sessions in Slack, for PRs, data analysis, incident investigation or product brainstorming.
- Not a like-for-like copy of Devin: opinionated where we chose differently.

## Try it in Cloud

_Goal: the fastest path to a working @computer, in three steps and about two minutes. This is the main CTA._

<p align="center">
  <a href="https://opencomputer.dev/blog/cloud-agents-as-fast-as-local/"><img src="docs/images/readme-benchmark.gif" alt="Slack message to first push, median of 5 runs: @Computer finishes first, ahead of Replicas, Capy, Hoplite and Devin" width="100%"></a>
</p>

- **3.3x faster than Devin**: all 4 PRs open with CI green in 56s vs 185s ([benchmark](https://opencomputer.dev/blog/cloud-agents-as-fast-as-local/))
- **2.6x faster than the average of the 4 most popular cloud agents**: first push in 24s vs a 62s average ([benchmark](https://opencomputer.dev/blog/cloud-agents-as-fast-as-local/))
- **3-day free trial** with 600 work minutes
- **Bring your own ChatGPT / Codex subscription**

TODO: 1. Sign up · 2. Add to Slack and connect GitHub · 3. Mention `@computer` with a task.

## Self-host

_Goal: the reader knows self-hosting is real and supported, what it needs, and where the guide is, without the README becoming the guide._

TODO: requirements in one line (Slack app, GitHub App, model key, domain, one VM), a short install snippet, links to the quickstart and AWS / Azure / GCP / VPS guides.

From launch post: AWS, Azure, GCP and OCI, Kubernetes soon; the whole stack can run on a single VM. (Docs nav lists AWS / Azure / GCP / VPS, no OCI yet.)

## Cloud or self-hosted

_Goal: an honest comparison that makes Cloud the obvious default for most teams and self-hosting the right call for some._

TODO: small table: setup time, maintenance, computers per task, scaling, where data lives, price.

From launch post: an always-on team VM gets cheaper than a sandbox per session at around 500 PRs a month (their chart compares against E2B 2 vCPU / 8 GB). Fits a self-host or cost row.

## How it works

_Goal: the reader can draw Slack → gateway ← host → runner and knows what each piece owns._

TODO: diagram (image, not ASCII) and one sentence per piece. Link to Architecture.

From launch post: it wants the same two visuals: (1) VM per session vs one VM per team with isolated sessions on top; (2) the gateway spawning sessions and worktrees, backing them up after each turn, scaling out. Draw once, use in both.

## Docs

_Goal: one list of links to the docs that matter._

TODO: Quickstart · Architecture · Self-hosting · Configuration · Security · API.

## Community and contributing

_Goal: where to ask, how to report a bug, how to contribute._

TODO: Slack community, GitHub issues, CONTRIBUTING.md, security contact.

## License

TODO: which license (repo root has LICENSE; `computer/` has its own NOTICE).
