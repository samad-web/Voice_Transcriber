#!/usr/bin/env bash
#
# Build the self-hosted database and load the exported data into it.
#
#   TARGET_DATABASE_URL='postgresql://postgres:PW@supabase-db:5432/postgres' \
#   TARGET_APP_DATABASE_URL='postgresql://aura_app:PW@supabase-db:5432/postgres' \
#   APP_DB_PASSWORD='...' \
#   bash bin/import-to-selfhost.sh ./dump
#
# Safe to run as a REHEARSAL while production is still live on Supabase Cloud -
# it only ever writes to the target, and it refuses to run if the target looks
# like a Supabase Cloud host. Run it as a rehearsal at least once before the
# cutover window; that rehearsal is also what proves the restore works, which
# DB_LATENCY_MIGRATION.md makes a precondition of starting.
#
# ── ORDER MATTERS, AND NOT FOR THE OBVIOUS REASON ────────────────────────────
#
# The schema is built by packages/db/migrations against an EMPTY
# schema_migrations, then rows are loaded on top. That ordering is what makes
# 0007_supabase_hardening.sql actually execute - and 0007 is the only thing that
# stops the Data API serving every tenant's calls to anyone holding the public
# anon key. Restoring a schema dump instead would mark 0007 "already applied",
# skip it, and leave the grants a fresh Supabase database hands out by default.
# See the long note in bin/export-from-cloud.sh.
set -euo pipefail

DUMP_DIR="${1:-./dump}"
DB_CONTAINER="${DB_CONTAINER:-aura-supabase-db}"
PLATFORM_DIR="${PLATFORM_DIR:-/opt/aura/platform}"
FORCE="${FORCE:-0}"

: "${TARGET_DATABASE_URL:?set TARGET_DATABASE_URL (the postgres superuser on the SELF-HOSTED database)}"
: "${TARGET_APP_DATABASE_URL:?set TARGET_APP_DATABASE_URL (the aura_app runtime role)}"
: "${APP_DB_PASSWORD:?set APP_DB_PASSWORD - bootstrap-role.js applies it to aura_app}"

for f in app-data.dump auth-users.sql auth-identities.sql row-exact.txt; do
  [ -f "$DUMP_DIR/$f" ] || { echo "FATAL: $DUMP_DIR/$f not found. Run bin/export-from-cloud.sh first." >&2; exit 1; }
done

# ── Refuse to write to Supabase Cloud ────────────────────────────────────────
#
# This script's whole job is to write data. Pointed at the wrong URL it would
# write it into the live cloud project, on top of the rows it came from. The
# argument order makes that a single-character mistake, so check rather than
# trust.
case "$TARGET_DATABASE_URL" in
  *supabase.co*|*pooler.supabase.com*)
    echo "FATAL: TARGET_DATABASE_URL points at Supabase Cloud." >&2
    echo "This script writes. The target must be the SELF-HOSTED database." >&2
    exit 1
    ;;
esac

in_db() { docker exec -i -e PGCONNECT_TIMEOUT=15 "$DB_CONTAINER" "$@"; }

echo "── 0/7  target check ──"
in_db psql "$TARGET_DATABASE_URL" -Atc "SELECT 'target: ' || current_database() || ' @ ' || inet_server_addr();"

# A non-empty target means this is a re-run. Loading twice would duplicate every
# row, and the primary keys would only catch some of it.
existing=$(in_db psql "$TARGET_DATABASE_URL" -Atc \
  "SELECT coalesce((SELECT count(*) FROM public.calls), 0);" 2>/dev/null || echo 0)
if [ "$existing" != "0" ] && [ "$FORCE" != "1" ]; then
  echo "FATAL: the target already holds $existing call(s)." >&2
  echo "Loading again would duplicate rows. Drop and recreate the database, or" >&2
  echo "re-run with FORCE=1 if you are certain the target is empty of real data." >&2
  exit 1
fi

echo
echo "── 1/7  build the schema from packages/db/migrations ──"
# Uses the aura project's own migrate job, with the connection overridden - so
# the schema is built by exactly the code that builds it everywhere else
# (migrate.js, then bootstrap-role.js, then verify-rls.js --structural-only).
docker compose \
  --env-file "$PLATFORM_DIR/.env.production" \
  -f "$PLATFORM_DIR/docker-compose.prod.yml" \
  --profile setup run --rm \
  -e DATABASE_URL="$TARGET_DATABASE_URL" \
  -e APP_DATABASE_URL="$TARGET_APP_DATABASE_URL" \
  -e APP_DB_PASSWORD="$APP_DB_PASSWORD" \
  -e DB_SSL=0 \
  migrate

echo
echo "── 2/7  confirm 0007 actually ran (it is the Data API lock) ──"
applied=$(in_db psql "$TARGET_DATABASE_URL" -Atc \
  "SELECT count(*) FROM schema_migrations WHERE name = '0007_supabase_hardening.sql';")
if [ "$applied" != "1" ]; then
  echo "FATAL: 0007_supabase_hardening.sql is not recorded as applied." >&2
  echo "Do not continue - anon/authenticated may still hold grants on public." >&2
  exit 1
fi
echo "   0007 applied"

echo
echo "── 3/7  load application rows ──"
# --disable-triggers wraps the load in session_replication_role = replica, so
# foreign keys do not care what order the tables arrive in. Needs superuser on
# the target, which self-hosted postgres gives us and Supabase Cloud never did.
# --single-transaction so a failure leaves nothing half-loaded.
docker exec -i "$DB_CONTAINER" pg_restore \
  --dbname="$TARGET_DATABASE_URL" \
  --data-only --disable-triggers --no-owner --no-acl \
  --single-transaction \
  < "$DUMP_DIR/app-data.dump"
echo "   loaded"

echo
echo "── 4/7  load auth users (users first, then identities - FK order) ──"
in_db psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -q < "$DUMP_DIR/auth-users.sql"
in_db psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -q < "$DUMP_DIR/auth-identities.sql"
auth_users=$(in_db psql "$TARGET_DATABASE_URL" -Atc "SELECT count(*) FROM auth.users;")
echo "   $auth_users auth user(s)"

# The binding that makes those users mean anything. users.sso_subject holds the
# Supabase user UUID as text - it is the ONLY link between the auth system and
# the application schema (nothing joins auth.users in SQL), which is exactly why
# preserving the UUIDs is the one non-negotiable part of the auth migration.
orphans=$(in_db psql "$TARGET_DATABASE_URL" -Atc "
  SELECT count(*) FROM users u
   WHERE u.sso_subject IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id::text = u.sso_subject);
")
if [ "$orphans" != "0" ]; then
  echo "   WARNING: $orphans platform user(s) have an sso_subject with no matching auth user."
  echo "            Those people cannot sign in. Re-provision them from the console"
  echo "            (instance page -> Create owner login) after cutover."
else
  echo "   every sso_subject resolves to an auth user"
fi

echo
echo "── 5/7  re-assert the hardening ──"
# Idempotent, and deliberately belt-and-braces: 0007 ran in step 1, but every
# statement in it is guarded and re-runnable, and the cost of it having silently
# not taken is every tenant's data on a public endpoint. Cheap insurance.
in_db psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -q \
  < "$PLATFORM_DIR/packages/db/migrations/0007_supabase_hardening.sql"
echo "   re-applied 0007_supabase_hardening.sql"

echo
echo "── 6/7  row counts against the export manifest ──"
fail=0
while IFS='=' read -r table expected; do
  [ -n "$table" ] || continue
  actual=$(in_db psql "$TARGET_DATABASE_URL" -Atc "SELECT count(*) FROM public.$table;")
  if [ "$actual" = "$expected" ]; then
    printf '   %-14s %s\n' "$table" "$actual"
  else
    printf '   %-14s %s  EXPECTED %s  <-- MISMATCH\n' "$table" "$actual" "$expected"
    fail=1
  fi
done < "$DUMP_DIR/row-exact.txt"

if [ "$fail" = "1" ]; then
  echo
  echo "FATAL: row counts do not match the export. Do not cut over." >&2
  exit 1
fi

echo
echo "── 7/7  RLS structural verification, after the data load ──"
# Step 1's migrate job already ran this against the empty schema. Running it
# again on the loaded database is cheap, and it is the check that would catch a
# restore having disturbed FORCE RLS or a policy - the failure that does not
# announce itself until one tenant sees another's calls.
#
# Command override after the service name, which is the form DEPLOYMENT.md uses
# and this repo has actually run; no --entrypoint juggling.
docker compose \
  --env-file "$PLATFORM_DIR/.env.production" \
  -f "$PLATFORM_DIR/docker-compose.prod.yml" \
  --profile setup run --rm \
  -e DATABASE_URL="$TARGET_DATABASE_URL" \
  -e APP_DATABASE_URL="$TARGET_APP_DATABASE_URL" \
  -e DB_SSL=0 \
  migrate node packages/db/verify-rls.js --structural-only

echo
echo "Import complete."
echo
echo "STILL TO DO before this database can serve traffic:"
echo "  1. bash $PLATFORM_DIR/scripts/apply-marketing-schema.sh <env-file>"
echo "     creates the aura_marketing role and rotates its password. The"
echo "     marketing container cannot connect without it. Put the printed"
echo "     password into FUNNEL_DATABASE_URL."
echo "  2. bash bin/verify-selfhost.sh   - proves the anon key cannot read"
echo "     tenant data, and that no container is published on 0.0.0.0."
