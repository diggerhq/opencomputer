#!/bin/sh
# Gateway container entrypoint: give the data volume to `node`, then drop root.
# Container platforms mount volumes root-owned; the gateway writes SQLite (SP_DB) there.
set -eu

DATA_DIR="$(dirname "${SP_DB:-/data/gateway.db}")"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown node:node "$DATA_DIR"
  # Existing database files (and SQLite's -wal/-shm siblings) from older images.
  find "$DATA_DIR" -maxdepth 1 -name '*.db*' -exec chown node:node {} +
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
