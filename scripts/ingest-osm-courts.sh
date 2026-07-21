#!/usr/bin/env bash
# Bulk-load basketball + pickleball courts from OpenStreetMap into public.venues.
# Offline pipeline — no API rate limits. Run on a machine with `osmium` (osmium-tool)
# and Node 18+. Needs several GB free disk and a few minutes.
#
#   SUPABASE_URL=https://<ref>.supabase.co \
#   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
#     bash scripts/ingest-osm-courts.sh
#
# Cover one state instead of the whole US by pointing EXTRACT_URL at a state
# extract, e.g. https://download.geofabrik.de/north-america/us/california-latest.osm.pbf
#
# SQL-file mode (no service-role key; apply chunks with the Supabase CLI):
#   SQL_OUT=./out bash scripts/ingest-osm-courts.sh
#   for f in out/chunk-*.sql; do supabase db query --linked -f "$f"; done
set -euo pipefail

EXTRACT_URL="${EXTRACT_URL:-https://download.geofabrik.de/north-america/us-latest.osm.pbf}"

PBF="${PBF:-us-latest.osm.pbf}"
FILTERED="courts-filtered.osm.pbf"
SEQ="courts.geojsonseq"

echo "1/4 Downloading extract ($EXTRACT_URL) — this is large (~10 GB for the full US)…"
[ -f "$PBF" ] || curl -L --fail -o "$PBF" "$EXTRACT_URL"

echo "2/4 Filtering to court-relevant features…"
# Broad filter (pitches, sports centres, and anything tagged with a sport we track);
# load-osm-courts.mjs refines to basketball / pickleball precisely.
osmium tags-filter "$PBF" \
  nwr/leisure=pitch \
  nwr/leisure=sports_centre \
  nwr/sport=basketball,pickleball,tennis \
  -o "$FILTERED" --overwrite

echo "3/4 Exporting to line-delimited GeoJSON (with osm type+id)…"
osmium export "$FILTERED" -f geojsonseq --add-unique-id=type_id -o "$SEQ" --overwrite

echo "4/4 Loading into public.venues (idempotent upsert)…"
node "$(dirname "$0")/load-osm-courts.mjs" "$SEQ"

echo "Done. Re-run any time — deterministic ids keep it idempotent."
