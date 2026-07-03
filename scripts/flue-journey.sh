#!/usr/bin/env bash
set -euo pipefail

# Flue agent — the stranger's journey (design 012 §11.8), run end to end against
# a live sessions-api. clone → deploy → chat, using only the `oc` CLI.
#
# This is the acceptance harness for the Flue slice: when the artifact-upload
# endpoint and the flue runtime image are live in prod, this script exercises the
# whole path a real user follows.
#
# ── Branch CLI build notes ──────────────────────────────────────────────────
# The Flue deploy flow (`oc agent deploy` on a family="flue" app) is not in a
# released `oc` yet — build it from this branch:
#
#     cd cmd/oc && go build -o /tmp/oc-flue . && export OC=/tmp/oc-flue
#
# or just run this script from a checkout of the branch — with no $OC set it
# builds `oc` from ./cmd/oc automatically (needs a Go toolchain).
#
# ── Prerequisites ───────────────────────────────────────────────────────────
#   - node >= 22.19 and npm (a Flue developer has these; oc-flue-build needs them)
#   - OPENCOMPUTER_API_KEY exported (an OpenComputer API key)
#   - git
#
# ── Usage ───────────────────────────────────────────────────────────────────
#   OPENCOMPUTER_API_KEY=oc_... scripts/flue-journey.sh
#
# Env overrides:
#   OC                  path to the oc binary            (default: build from ./cmd/oc)
#   STARTER_REPO        starter git URL                  (default: diggerhq/oc-flue-starter)
#   SESSIONS_API_URL    control-plane URL                (default: the CLI default, prod)
#   AGENT_NAME          agent name                       (default: from the starter's agent.toml)
#   INPUT               first message to the agent
#   SOURCE              optional owner/repo[@ref] to attach as a working source
#   KEEP                set to 1 to keep the temp workdir

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STARTER_REPO="${STARTER_REPO:-https://github.com/diggerhq/oc-flue-starter}"
INPUT="${INPUT:-Customer says order 1042 has not arrived yet - what should I tell them?}"

: "${OPENCOMPUTER_API_KEY:?export OPENCOMPUTER_API_KEY first}"

# Resolve the oc binary — build from this branch if none was provided.
OC="${OC:-}"
if [[ -z "$OC" ]]; then
  OC="$(mktemp -d)/oc"
  echo "→ building oc from $REPO_ROOT/cmd/oc"
  ( cd "$REPO_ROOT/cmd/oc" && go build -o "$OC" . )
fi
echo "→ using oc: $OC"
"$OC" --version 2>/dev/null || true

WORK="$(mktemp -d)"
cleanup() { [[ "${KEEP:-0}" == "1" ]] || rm -rf "$WORK"; }
trap cleanup EXIT

echo "→ clone $STARTER_REPO"
git clone --depth 1 "$STARTER_REPO" "$WORK/app"
cd "$WORK/app"

echo "→ npm install (brings in @opencomputer/flue → oc-flue-build)"
npm install

# Agent name: explicit override, else the starter's agent.toml [name].
AGENT_NAME="${AGENT_NAME:-$(sed -n 's/^name[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' agent.toml | head -1)}"
MODEL="$(sed -n 's/^model[[:space:]]*=[[:space:]]*"\(.*\)".*/\1/p' agent.toml | head -1)"
echo "→ agent: ${AGENT_NAME:-<from agent.toml>}  model: ${MODEL:-<from agent.toml>}"

# create is optional — `oc agent deploy` creates by name from agent.toml — but we
# show it to demonstrate that a flue agent needs no --prompt.
if [[ -n "$AGENT_NAME" && -n "$MODEL" ]]; then
  echo "→ oc agent create --runtime flue (no --prompt for flue)"
  "$OC" agent create "$AGENT_NAME" --runtime flue --model "$MODEL" || \
    echo "  (agent may already exist — continuing)"
fi

echo "→ oc agent deploy   (build → upload → boot-verify → activate)"
"$OC" agent deploy

echo "→ oc session create"
create_args=(--input "$INPUT")
[[ -n "${AGENT_NAME:-}" ]] && create_args+=(--agent "$AGENT_NAME")
[[ -n "${SOURCE:-}" ]] && create_args+=(--source "$SOURCE")
SID="$("$OC" session create "${create_args[@]}" --json | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
echo "  session: $SID"

echo "→ oc session logs $SID"
"$OC" session logs "$SID"

echo "✓ journey complete — follow with: $OC session logs $SID"
