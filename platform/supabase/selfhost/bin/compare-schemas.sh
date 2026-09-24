#!/usr/bin/env bash
#
# Compare the cloud database's columns against what packages/db/migrations
# actually produces on the self-hosted one.
#
#   TARGET_DATABASE_URL='postgresql://postgres:PW@supabase-db:5432/postgres' \
#   bash bin/compare-schemas.sh ./dump
#
# Run this DURING THE REHEARSAL, after bin/import-to-selfhost.sh has built the
# schema and before the cutover window. It is a five-second check that turns a
# mid-window surprise into a scheduling decision.
#
# ── WHY THIS IS NOT PARANOIA ON THIS PROJECT ─────────────────────────────────
#
# Migration numbers here have genuinely drifted: two branches allocated them
# independently, production once had 0051/0052 hand-applied while 0034-0050 did
# not exist on the box, and a local migration turned out to be a byte-identical
# rename of one already upstream. schema_migrations cannot be trusted blind.
#
# The data-only restore compares columns for real, and fails loudly if they
# disagree - but it fails halfway through loading, in the window, at night. This
# asks the same question in advance.
set -euo pipefail

DUMP_DIR="${1:-./dump}"
DB_CONTAINER="${DB_CONTAINER:-aura-supabase-db}"
: "${TARGET_DATABASE_URL:?set TARGET_DATABASE_URL (the self-hosted database)}"

CLOUD_FILE="$DUMP_DIR/columns-cloud.txt"
[ -f "$CLOUD_FILE" ] || { echo "FATAL: $CLOUD_FILE not found. Run bin/export-from-cloud.sh first." >&2; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

docker exec -i "$DB_CONTAINER" psql "$TARGET_DATABASE_URL" -Atc "
  SELECT string_agg(format('%s.%s.%s:%s', table_schema, table_name, column_name, data_type), E'\n'
                    ORDER BY table_schema, table_name, column_name)
    FROM information_schema.columns
   WHERE table_schema IN ('public','marketing');
" > "$TMP/selfhost.txt"

sort "$CLOUD_FILE"    | grep -v '^$' > "$TMP/a"
sort "$TMP/selfhost.txt" | grep -v '^$' > "$TMP/b"

only_cloud=$(comm -23 "$TMP/a" "$TMP/b")
only_self=$(comm -13 "$TMP/a" "$TMP/b")

echo "cloud:     $(wc -l < "$TMP/a") column(s)"
echo "selfhost:  $(wc -l < "$TMP/b") column(s)"
echo

status=0

if [ -n "$only_cloud" ]; then
  # THE DANGEROUS DIRECTION. A column that exists in the cloud but not here has
  # nowhere to land, and the data-only restore will abort on that table.
  echo "── In CLOUD but NOT self-hosted (the restore WILL fail on these) ──"
  echo "$only_cloud" | sed 's/^/  /'
  echo
  status=1
fi

if [ -n "$only_self" ]; then
  # Usually benign: a migration applied here that production has not taken yet,
  # or a type the restore will widen into. Worth reading, not worth blocking.
  echo "── In SELF-HOSTED but not cloud (usually a newer migration; harmless) ──"
  echo "$only_self" | sed 's/^/  /'
  echo
fi

# schema_migrations is the ledger, not the truth. Compare the two lists so a
# renamed or renumbered migration shows up as itself rather than as a count.
echo "── migration ledger ──"
docker exec -i "$DB_CONTAINER" psql "$TARGET_DATABASE_URL" -Atc \
  "SELECT count(*) FROM schema_migrations;" | sed 's/^/  self-hosted has /;s/$/ migration(s) recorded/'
echo "  repo has $(ls -1 "$(dirname "$0")/../../../packages/db/migrations"/*.sql | wc -l) migration file(s)"

if [ "$status" = "0" ]; then
  echo
  echo "Schemas are compatible - the data-only restore has somewhere to put every column."
else
  echo "STOP: resolve the missing columns before the cutover window."
fi
exit "$status"
