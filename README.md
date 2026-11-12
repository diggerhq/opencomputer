<p align="center">
  <img src="docs/images/readme-banner.svg" alt="OpenComputer" width="100%">
</p>

<p align="center">
  The open-source Devin alternative: a coding agent your team works with in Slack, on its own computers, in your cloud or ours.
</p>

<p align="center">
  <a href="https://app.opencomputer.dev">Cloud</a> | <a href="https://docs.opencomputer.dev">Self-hosting</a> | <a href="https://docs.opencomputer.dev">Docs</a> | <a href="https://opencomputer.dev">Website</a> | <a href="https://opencomputer.dev/blog/cloud-agents-as-fast-as-local/">Benchmark</a> | <a href="https://join.slack.com/t/opencomputercommunity/shared_invite/zt-4gtztz4io-~LZMreyHyTryoEVhs2hUPA">Community</a> | <a href="https://x.com/opencomputerHQ">X</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/diggerhq/opencomputer?style=for-the-badge"></a>
  <a href="https://github.com/diggerhq/opencomputer/releases"><img alt="Release" src="https://img.shields.io/github/v/release/diggerhq/opencomputer?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="https://app.opencomputer.dev"><img alt="Try OpenComputer in Slack" src="https://img.shields.io/badge/Try_OpenComputer_in_Slack-4A154B?style=for-the-badge&logo=slack&logoColor=white"></a>
</p>

## Introduction

OpenComputer is the open source, self hostable alternative to Devin. Mention `@Computer` in a Slack thread with a task, it works on its own computer, you & your team can watch and steer it as it goes, and the result lands as a pull request.

It is open source from the compute layer up, so you can run all of it in your own cloud account, or start on OpenComputer Cloud in two minutes.

We built it to feel as fast as Claude Code on your laptop: in our benchmark it opens PRs 3.3x faster than Devin.

## See it work

<p align="center">
  <img src="docs/images/readme-slack.gif" alt="A Slack thread: someone mentions @Computer, and it replies in the thread within seconds" width="70%">
</p>

## As fast as local

<p align="center">
  <img src="docs/images/readme-vs-local.gif" alt="Side-by-side race on the same task: Claude Code on a laptop against @Computer in the cloud; @Computer finishes in 32.0s, local in 36.2s" width="70%">
</p>

## How it works

OpenComputer is built to be simple to self-host without giving up scale or security. The whole stack runs on a single VM, which we recommend locking down to outbound-only network access.

The VM runs the gateway, Calvin: a thin bridge that listens for Slack events and starts a session with Claude Code, Codex or OpenCode, depending on your configuration. Each session is isolated with rootless Podman. Its state is written first to the VM's local disk, then persisted to a git-backed store.

The rest of the stack runs on Cloudflare Workers and Durable Objects. Support for Fly and other platforms is coming soon.

<p align="center">
  <img src="docs/images/readme-architecture.png" alt="Slack sends events to Cloudflare Workers and Durable Objects. Your VM, outbound only, dials out to them over a websocket. On the VM, the Calvin gateway starts a Claude Code, Codex or OpenCode session per thread, each in rootless Podman. State is written to the VM's local disk first, then persisted to a git-backed store." width="100%">
</p>

## Try it in Cloud

The fastest way to experience `@Computer` is to install the Slack app from the cloud: [sign up here](https://app.opencomputer.dev), connect your repos, and install the Slack app to get started.

<p align="center">
  <a href="https://opencomputer.dev/blog/cloud-agents-as-fast-as-local/"><img src="docs/images/readme-benchmark.gif" alt="Slack message to first push, median of 5 runs: @Computer finishes first, ahead of Replicas, Capy, Hoplite and Devin" width="70%"></a>
</p>

- **3.3x faster than Devin**: all 4 PRs open with CI green in 56s vs 185s ([benchmark](https://opencomputer.dev/blog/cloud-agents-as-fast-as-local/))
- **2.6x faster than the average of the 4 most popular cloud agents**: first push in 24s vs a 62s average ([benchmark](https://opencomputer.dev/blog/cloud-agents-as-fast-as-local/))
- **3-day free trial** with 600 work minutes
- **Bring your own ChatGPT / Codex subscription**

## Self-host

<!-- TODO: point each button at its guide once the self-hosting docs are live. -->
<p align="center">
  <a href="https://docs.opencomputer.dev"><img alt="Self-host on AWS" src="https://img.shields.io/badge/Self--host_on_AWS-232F3E?style=for-the-badge"></a>
  <a href="https://docs.opencomputer.dev"><img alt="Self-host on GCP" src="https://img.shields.io/badge/Self--host_on_GCP-4285F4?style=for-the-badge"></a>
  <a href="https://docs.opencomputer.dev"><img alt="Self-host on Azure" src="https://img.shields.io/badge/Self--host_on_Azure-0078D4?style=for-the-badge"></a>
</p>

## License

Apache 2.0. See [LICENSE](LICENSE).
