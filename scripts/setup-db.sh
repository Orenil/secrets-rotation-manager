#!/usr/bin/env bash
# Stands up a disposable local Postgres cluster for this project, isolated
# from any system Postgres install: its own data dir, its own port, trust
# auth (local dev/test only). Idempotent - safe to re-run.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA="$DIR/.pgdata"
PORT="${PGPORT:-5544}"
LOGFILE="$DIR/.pgdata.log"

if [ ! -d "$PGDATA" ]; then
  echo "Initializing Postgres cluster at $PGDATA (port $PORT)..."
  initdb -D "$PGDATA" -U postgres -A trust --no-locale -E UTF8 >/dev/null
fi

if ! pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  echo "Starting Postgres on port $PORT..."
  pg_ctl -D "$PGDATA" -o "-p $PORT -k $PGDATA -c listen_addresses=127.0.0.1" -l "$LOGFILE" start
  for i in $(seq 1 30); do
    pg_isready -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1 && break
    sleep 0.3
  done
fi

psql -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname = 'rotation_manager'" | grep -q 1 || \
  psql -h 127.0.0.1 -p "$PORT" -U postgres -d postgres -c "CREATE DATABASE rotation_manager"

psql -h 127.0.0.1 -p "$PORT" -U postgres -d rotation_manager -tc \
  "SELECT 1 FROM pg_roles WHERE rolname = 'app_group'" | grep -q 1 || \
  psql -h 127.0.0.1 -p "$PORT" -U postgres -d rotation_manager -c "CREATE ROLE app_group NOLOGIN"

psql -h 127.0.0.1 -p "$PORT" -U postgres -d rotation_manager -f "$DIR/src/db/migrations.sql" >/dev/null

echo "Postgres ready: postgresql://postgres@127.0.0.1:$PORT/rotation_manager"
