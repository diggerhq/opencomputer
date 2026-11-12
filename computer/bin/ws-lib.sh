# Shared by the ws-*.sh scripts (work 103, seam S2): sourced, never run.
#
# The scripts hold the git sequences of src/workspaces; TypeScript keeps the
# locks, the scheduling, the telemetry and the parsing (script-runner.ts).
# Paths are arguments, so a script does not know where it runs.
#
# Contract of every script:
# - one line per repository on stdout, tab-separated: the repository, `ok` or
#   `failed`, then what the script documents; a failed line's third field is a
#   one-line message. The exit status is non-zero only for a wrong call.
#   A field never holds a tab or a newline: a name that could (a directory a
#   session made) is answered by its position in the input (ws-inspect.sh).
# - running it twice gives the same result.
# - git never prompts, and a command that can take long (clone, fetch, a
#   checkout) ends with the script when the script is signalled.

export GIT_TERMINAL_PROMPT=0
ws_tab=$(printf '\t')
ws_tmp=$(mktemp -d "${TMPDIR:-/tmp}/ws.XXXXXX")
ws_pid=
# What a script leaves half done when it is stopped; scripts redefine it.
ws_cleanup() { :; }
trap 'rm -rf "$ws_tmp"' EXIT
ws_stop() {
  trap - TERM INT HUP
  if [ -n "$ws_pid" ]; then
    kill "$ws_pid" 2>/dev/null || :
    wait "$ws_pid" 2>/dev/null || :
  fi
  ws_cleanup || :
  exit 143
}
trap ws_stop TERM INT HUP

# ws_in <dir> <command…>: run it there and wait in a way a signal interrupts
# (the shell does not run a trap while a foreground command runs). Its stderr
# is kept for ws_why; returns its status.
ws_in() {
  ws_dir=$1
  shift
  (cd "$ws_dir" && exec "$@") 2>"$ws_tmp/err" </dev/null &
  ws_pid=$!
  ws_rc=0
  wait "$ws_pid" || ws_rc=$?
  ws_pid=
  return "$ws_rc"
}

# ws_q <dir> <command…>: a quick command there, in the foreground, for $(…).
ws_q() {
  ws_dir=$1
  shift
  (cd "$ws_dir" && exec "$@") 2>"$ws_tmp/err" </dev/null
}

# ws_why <fallback>: why the last ws_in or ws_q failed, in one line: git's
# first `fatal:` or `error:` line, else the last line it wrote (errText in clones.ts).
ws_why() {
  ws_m=$(grep -E '^(fatal|error):' "$ws_tmp/err" 2>/dev/null | head -n 1) || :
  [ -n "$ws_m" ] || ws_m=$(grep -v '^$' "$ws_tmp/err" 2>/dev/null | tail -n 1) || :
  [ -n "$ws_m" ] || ws_m=$1
  printf '%s' "$ws_m" | tr '\t\r\n' '   '
}

# ws_ok <repo> <field…>, ws_failed <repo> <message>: the repository's line.
ws_ok() {
  ws_line=$1
  shift
  for ws_f in ok "$@"; do ws_line=$ws_line$ws_tab$ws_f; done
  printf '%s\n' "$ws_line"
}
ws_failed() {
  printf '%s\tfailed\t%s\n' "$1" "$(printf '%s' "$2" | tr '\t\r\n' '   ')"
}

# ws_base <clone>: sets ws_b to the branch the clone's forks start from:
# origin/HEAD, asked of the remote once when the clone does not know it.
ws_base() {
  ws_b=$(ws_q "$1" git symbolic-ref --short refs/remotes/origin/HEAD) || {
    ws_in "$1" git remote set-head origin --auto >/dev/null || return 1
    ws_b=$(ws_q "$1" git symbolic-ref --short refs/remotes/origin/HEAD) || return 1
  }
  ws_b=${ws_b#origin/}
}
