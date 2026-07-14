#!/usr/bin/env bash
set -euo pipefail

# Flue agent — the stranger's journey (design 012 §11.8), run end to end against
# a live sessions-api. clone → deploy → chat, using only the `oc` CLI.
#
# This is the acceptance journey for the Flue slice. It exercises the same
# clone → install → deploy → session path a user follows.
#
# ── Prerequisites ───────────────────────────────────────────────────────────
#   - node >= 22.19 and npm (required by the current Flue toolchain)
#   - an authenticated `oc` CLI (`oc auth login` or OPENCOMPUTER_API_KEY)
#   - git
#
# ── Usage ───────────────────────────────────────────────────────────────────
#   scripts/flue-journey.sh
#
# Env overrides:
#   OC                  path to the oc binary            (default: oc from PATH)
#   STARTER_REPO        starter git URL                  (default: diggerhq/oc-flue-starter)
#   SESSIONS_API_URL    control-plane URL                (default: the CLI default, prod)
#   AGENT_NAME          agent name                       (default: from the starter's agent.toml)
#   INPUT               first message to the agent
#   KEEP                set to 1 to keep the temp workdir

STARTER_REPO="${STARTER_REPO:-https://github.com/diggerhq/oc-flue-starter}"
INPUT="${INPUT:-Customer says order 2203 arrived with a torn shoulder strap - what should I tell them?}"

OC="${OC:-oc}"
if ! command -v "$OC" >/dev/null 2>&1; then
  echo "oc CLI not found; install it or set OC=/path/to/oc" >&2
  exit 1
fi
echo "→ using oc: $OC"
"$OC" --version 2>/dev/null || true

WORK="$(mktemp -d)"
cleanup() { [[ "${KEEP:-0}" == "1" ]] || rm -rf "$WORK"; }
trap cleanup EXIT

echo "→ clone $STARTER_REPO"
git clone --depth 1 "$STARTER_REPO" "$WORK/app"
cd "$WORK/app"

echo "→ npm install (Flue toolchain + OpenComputer integration)"
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
SID="$("$OC" session create "${create_args[@]}" --json | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
echo "  session: $SID"

echo "→ oc session logs $SID"
"$OC" session logs "$SID"

echo "✓ journey complete — follow with: $OC session logs $SID"
