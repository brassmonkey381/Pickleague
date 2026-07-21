#!/usr/bin/env bash
# Bulk-load multi-sport playing venues from OpenStreetMap into public.venues.
# Covers basketball, pickleball, tennis, soccer, volleyball (incl. beach), baseball,
# softball, skateboarding, disc golf, and bocce. Offline pipeline — no API rate limits.
# Run on a machine with `osmium` (osmium-tool) and Node 18+. Needs several GB free disk.
#
#   SUPABASE_URL=https://<ref>.supabase.co \
#   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
#     bash scripts/ingest-osm-venues.sh
#
# Cover one state instead of the whole US by pointing EXTRACT_URL at a state extract,
# e.g. https://download.geofabrik.de/north-america/us/california-latest.osm.pbf
#
# SQL-file mode (no service-role key; apply chunks with the Supabase CLI):
#   SQL_OUT=./out bash scripts/ingest-osm-venues.sh
#   for f in out/chunk-*.sql; do supabase db query --linked -f "$f"; done
#
# To add a sport: add its sport= value(s) to the tags-filter below AND to
# SPORT_ALIASES in load-osm-venues.mjs. The DB needs no change.
set -euo pipefail

EXTRACT_URL="${EXTRACT_URL:-https://download.geofabrik.de/north-america/us/california-latest.osm.pbf}"

PBF="${PBF:-california-latest.osm.pbf}"
FILTERED="venues-filtered.osm.pbf"
SEQ="venues.geojsonseq"

# osmium CLI: OSMIUM_BIN override → PATH → the known conda-env install on this
# dev machine (osmium-tool lives in the tf_2 env; the base env only has pyosmium,
# the Python bindings, which provide no `osmium` command).
OSMIUM="${OSMIUM_BIN:-}"
if [ -z "$OSMIUM" ]; then
  if command -v osmium >/dev/null 2>&1; then
    OSMIUM=osmium
  elif [ -x "/c/Users/Brian/anaconda3/envs/tf_2/Library/bin/osmium.exe" ]; then
    OSMIUM="/c/Users/Brian/anaconda3/envs/tf_2/Library/bin/osmium.exe"
  else
    echo "osmium not found. Install osmium-tool (conda install -c conda-forge osmium-tool," >&2
    echo "or brew/apt install osmium-tool) or set OSMIUM_BIN to the executable path." >&2
    echo "Note: the 'osmium' conda/pip package is pyosmium (Python bindings) — it has NO CLI." >&2
    exit 1
  fi
fi

echo "1/4 Downloading extract ($EXTRACT_URL)…"
[ -f "$PBF" ] || curl -L --fail -o "$PBF" "$EXTRACT_URL"

echo "2/4 Filtering to sport venues…"
# Broad filter (pitches, sports centres, skateparks, disc-golf courses, and anything
# tagged with a sport we track); load-osm-venues.mjs refines to our sports precisely.
"$OSMIUM" tags-filter "$PBF" \
  nwr/leisure=pitch \
  nwr/leisure=sports_centre \
  nwr/leisure=skatepark \
  nwr/leisure=disc_golf_course \
  nwr/sport=basketball,pickleball,tennis,soccer,volleyball,beach_volleyball,baseball,softball,skateboard,disc_golf,bocce \
  -o "$FILTERED" --overwrite

echo "3/4 Exporting to line-delimited GeoJSON (with osm type+id)…"
"$OSMIUM" export "$FILTERED" -f geojsonseq --add-unique-id=type_id -o "$SEQ" --overwrite

echo "4/4 Loading into public.venues (idempotent upsert)…"
node "$(dirname "$0")/load-osm-venues.mjs" "$SEQ"

echo "Done. Re-run any time — deterministic ids keep it idempotent."
