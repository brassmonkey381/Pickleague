#!/usr/bin/env bash
# One-command venue ingest via the Overpass API — no osmium, no PBF, works on
# Windows (Git Bash). Pipes fetch-overpass-venues.mjs into load-osm-venues.mjs.
# This is the daily-driver ingest path; use ingest-osm-venues.sh (osmium) for
# whole-state/US bulk loads.
#
#   # straight into the DB:
#   SUPABASE_URL=.. SUPABASE_SERVICE_ROLE_KEY=.. \
#     bash scripts/ingest-overpass-venues.sh --bbox "37.70 -122.55 37.83 -122.35"
#   # a whole ISO area (may time out on the public Overpass server):
#   ... --area US-CA
#   # key-free SQL chunks (apply with: supabase db query --linked -f out/chunk-*.sql):
#   bash scripts/ingest-overpass-venues.sh --bbox "..." --sql-out ./out
#   # parse + summarize only, write nothing:
#   bash scripts/ingest-overpass-venues.sh --bbox "..." --dry-run
set -euo pipefail

BBOX="" AREA="" SQLOUT="" DRY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bbox)    BBOX="$2";   shift 2 ;;
    --area)    AREA="$2";   shift 2 ;;
    --sql-out) SQLOUT="$2"; shift 2 ;;
    --dry-run) DRY=1;       shift ;;
    *) echo "Unknown arg: $1 (use --bbox \"S W N E\" | --area US-XX [--sql-out dir] [--dry-run])"; exit 1 ;;
  esac
done

if [ -n "$BBOX" ]; then
  # shellcheck disable=SC2206 -- intentional word-split of the 4 bbox numbers
  ARGS=($BBOX)
  [ "${#ARGS[@]}" -eq 4 ] || { echo "--bbox needs 4 numbers: \"south west north east\""; exit 1; }
elif [ -n "$AREA" ]; then
  ARGS=("$AREA")
else
  echo "Need --bbox \"south west north east\" or --area US-XX"; exit 1
fi

DIR="$(dirname "$0")"
if [ -n "$DRY" ]; then
  node "$DIR/fetch-overpass-venues.mjs" "${ARGS[@]}" | DRY_RUN=1 node "$DIR/load-osm-venues.mjs"
elif [ -n "$SQLOUT" ]; then
  node "$DIR/fetch-overpass-venues.mjs" "${ARGS[@]}" | SQL_OUT="$SQLOUT" node "$DIR/load-osm-venues.mjs"
else
  node "$DIR/fetch-overpass-venues.mjs" "${ARGS[@]}" | node "$DIR/load-osm-venues.mjs"
fi
