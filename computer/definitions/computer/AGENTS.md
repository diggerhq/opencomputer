# Your organization's computer

You are running on this organization's OpenComputer computer, in a session
started from Slack. This directory is not a git repository: each subdirectory
is a `git worktree` of one of the organization's repositories (those its
GitHub connection grants), on a fresh branch `sp/<thread>` started from the
latest fetched default branch. Each repository's own `AGENTS.md` or `README.md`
is the place to start for work in it.

Not every repository is checked out up front. When some are not, the
"Repositories in this workspace" section at the end of this file lists all of
them; check out the ones a task needs with the `checkout_repo` tool.

## How work leaves this session

- Changes leave only through git: commit on your `sp/…` branch (or a
  better-named branch), `git push -u origin HEAD`, and open a pull request
  with `gh pr create`. Never push to a default branch unless the person asks.
- Say in pull request bodies who asked for the change
  (`Requested by @<person> in Slack`).
- Git and `gh` get short-lived tokens on their own. Never put a token in a
  remote URL, a file or a commit.
- This session's directory is its own; other threads have theirs. Directories
  with uncommitted or unpushed work are kept; idle, fully pushed ones are
  deleted after two weeks.

## Automations

An automation is an OpenComputer serverless agent project that runs on its
own schedule, without this computer: you write it, test it and deploy it, and
the organization sees it under Automations in its dashboard. When someone asks
for something recurring or watching ("every morning…", "let me know when…"),
offer once to make it an automation, naming what it will do, its schedule and
where its results go; one-off tasks stay one-off. Build it only when they say
yes. Never schedule recurring work in this session (`CronCreate`, `sleep`
loops, background jobs): the session parks and its jobs die with it. Asked
what automations exist, run `opencomputer agents`.

The `opencomputer` CLI is installed and signed in to this organization: each
call gets a one-hour key from the gateway, so never ask for an OpenComputer
key or URL, and never write one to a file.

- All of the organization's automations live in one repository, a folder
  each. Clone it into this session's directory once: `git clone
  "$(git-credential-slack-presence automation-remote)" automations` (it may
  be empty), or `git -C automations pull` if it is already there. Read it to
  see what exists before writing something new.
- A new automation: `opencomputer init automations/<name>`, then edit the
  agent under `opencomputer/agents/` and add schedules as files in
  `opencomputer/schedules/` (`defineSchedule` from `@opencomputer/agent`:
  `id`, `cron`, `timezone`, `enabled: ["default", "production"]`,
  `overlap: "skip"`, `dispatch: { text }`). In its folder, `npm install`,
  then once `opencomputer link --create-project <name>`.
- To change an existing one, work in its folder; `.opencomputer/` is not
  committed, so link it first with `opencomputer link --project <name>`.
- Deploy from the automation's folder: commit, `opencomputer deploy`, test it
  with `opencomputer session "<prompt>"`, then `git push origin HEAD:main`
  (when the push is refused, `git pull --rebase origin main` and push
  again), so the organization's copy of the code matches what runs. Push
  after every deploy, and tell the person it is done only once it is pushed.
- Secrets the automation needs go in with `opencomputer secrets set <name>
  --value-stdin`, piped from a secret set through `request_secret`; never
  print one.
- Automations cannot post back to Slack yet. Say so when offering, and keep
  results where the person can read them (the session in the dashboard, or a
  connection such as Gmail or Linear).
- Reply with what it does, its schedule and its project in the dashboard.

## Secrets

Ask for API keys and other secrets with the `request_secret` tool; people set
them through a private Slack form. Never ask for a secret in a message, and
never print, write or commit one.
