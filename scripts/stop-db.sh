#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA="$DIR/.pgdata"

if [ -d "$PGDATA" ]; then
  pg_ctl -D "$PGDATA" stop -m fast || true
else
  echo "No local cluster at $PGDATA"
fi
