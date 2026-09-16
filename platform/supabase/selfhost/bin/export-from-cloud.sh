#!/usr/bin/env bash
#
# Capture everything the self-hosted stack needs from the Supabase Cloud
# project. READ-ONLY - it never writes to the cloud database.
#
#   bash bin/export-from-cloud.sh 'postgresql://postgres.REF:PW@...pooler...:5432/postgres' ./dump
#
# Run it on the VPS. pg_dump must be at least as new as the server, and the
# supabase-db container already ships the right version, so everything here goes
# through `docker exec supabase-db` rather than asking you to install a client.
#
# ── WHY THIS IS A DATA-ONLY DUMP ─────────────────────────────────────────────
#
# The tempting version - pg_dump the whole schema and restore it - reproduces
# the schema AND `schema_migrations`, which then tells packages/db/migrate.js
# that everything is already applied. That is a silent data-exposure bug, not a
# tidiness problem:
#
#   0007_supabase_hardening.sql is what REVOKEs anon/authenticated access to
#   schema public. A fresh Supabase database grants those roles privileges on
#   every table `postgres` creates, by default. Restore the schema with
#   schema_migrations intact, and 0007 is skipped as "already applied" - so the
#   revokes never run, and the Data API happily serves every tenant's calls to
#   anyone holding the anon key, which is published in the browser bundle.
#
# So: the self-hosted schema is built by OUR migrations against an empty
# schema_migrations (0007 included, doing its job), and only rows are copied
# across. packages/db/migrations is the canonical schema; this dump is not.
#
# It also means the restore fails loudly on any column drift between the cloud
# database and what the migrations produce - which, on a project whose migration
# numbers have drifted across branches before, is the outcome you want. Run
# bin/compare-schemas.sh first to see any drift before the window rather than
# during it.
set -euo pipefail

CLOUD_URL="${1:-}"
OUT_DIR="${2:-./dump}"
DB_CONTAINER="${DB_CONTAINER:-supabase-db}"

if [ -z "$CLOUD_URL" ]; then
  echo "usage: bash $0 <cloud-database-url> [out-dir]" >&2
  echo "  the URL is DATABASE_URL from .env.production (the postgres owner role)" >&2
  exit 64
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; then
  echo "FATAL: container '$DB_CONTAINER' is not running." >&2
  echo "Start the self-hosted stack first - its pg_dump is what this script uses." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
# The dump contains every tenant's call transcripts. Do not leave it group- or
# world-readable on the box.
chmod 700 "$OUT_DIR"

# `docker exec -i` with no TTY, so binary dump output survives the pipe intact.
in_db() { docker exec -i -e PGCONNECT_TIMEOUT=15 "$DB_CONTAINER" "$@"; }

echo "── 1/5  connectivity and server version ──"
in_db psql "$CLOUD_URL" -Atc "SELECT 'connected to ' || current_database() || ' on ' || version();"

echo
echo "── 2/5  application data (public + marketing), excluding schema_migrations ──"
#   --data-only        the schema comes from our migrations, not from here
#   --disable-triggers emitted so the restore can load in any order without
#                      tripping foreign keys; needs superuser on the TARGET,
#                      which self-hosted postgres gives us and Cloud never did
#   -Fc                custom format, so pg_restore can filter and parallelise
in_db pg_dump "$CLOUD_URL" \
  --data-only \
  --disable-triggers \
  --no-owner --no-acl \
  --schema=public \
  --schema=marketing \
  --exclude-table-data=public.schema_migrations \
  -Fc > "$OUT_DIR/app-data.dump"
echo "   wrote $(du -h "$OUT_DIR/app-data.dump" | cut -f1) app-data.dump"

echo
echo "── 3/5  auth users ──"
#
# Users and identities are dumped SEPARATELY and in this order on purpose:
# auth.identities has a foreign key onto auth.users, and pg_dump would emit the
# tables alphabetically - identities first - which fails to restore.
#
# --column-inserts names every column explicitly, so this survives a GoTrue
# version whose auth.users has EXTRA columns. It fails loudly if the target is
# MISSING one, which is the right way round.
#
# Deliberately NOT exported: auth.sessions and auth.refresh_tokens. The
# self-hosted stack signs tokens with a different JWT_SECRET, so every existing
# session is void regardless - carrying the rows across would only preserve
# garbage. Everyone signs in once after cutover; nobody resets a password,
# because encrypted_password is a portable bcrypt hash and comes across below.
in_db pg_dump "$CLOUD_URL" \
  --data-only --column-inserts --no-owner --no-acl \
  --table=auth.users > "$OUT_DIR/auth-users.sql"

in_db pg_dump "$CLOUD_URL" \
  --data-only --column-inserts --no-owner --no-acl \
  --table=auth.identities > "$OUT_DIR/auth-identities.sql"

users_count=$(in_db psql "$CLOUD_URL" -Atc "SELECT count(*) FROM auth.users;")
echo "   $users_count auth user(s) exported"

# MFA is not something this platform provisions, but say so rather than assume.
mfa_count=$(in_db psql "$CLOUD_URL" -Atc \
  "SELECT count(*) FROM auth.mfa_factors WHERE status = 'verified';" 2>/dev/null || echo 0)
if [ "$mfa_count" != "0" ]; then
  echo "   WARNING: $mfa_count verified MFA factor(s) exist and are NOT exported."
  echo "            Those users will sign in with a password alone after cutover."
fi

echo
echo "── 4/5  row-count manifest (the post-restore comparison) ──"
# Counted per table so the import can prove it landed everything, rather than
# eyeballing "looks about right".
in_db psql "$CLOUD_URL" -Atc "
  SELECT string_agg(format('%s.%s=%s', schemaname, relname, n_live_tup), E'\n' ORDER BY schemaname, relname)
    FROM pg_stat_user_tables
   WHERE schemaname IN ('public','marketing');
" > "$OUT_DIR/row-estimates.txt"
echo "   $(wc -l < "$OUT_DIR/row-estimates.txt") table(s) recorded (planner estimates)"

# Exact counts for the tables whose loss would be most obvious, and cheap enough
# to count properly. Estimates above are for breadth; these are for trust.
# The keys here are read back by bin/import-to-selfhost.sh as literal table
# names, so they must BE the table names. The tenant root is `organizations`,
# not `orgs` - the app's shorthand is not what 0001_init.sql called it.
in_db psql "$CLOUD_URL" -Atc "
  SELECT 'calls=' || (SELECT count(*) FROM calls)
      || E'\norganizations=' || (SELECT count(*) FROM organizations)
      || E'\nusers=' || (SELECT count(*) FROM users)
      || E'\nmemberships=' || (SELECT count(*) FROM memberships);
" > "$OUT_DIR/row-exact.txt"
cat "$OUT_DIR/row-exact.txt" | sed 's/^/   /'

echo
echo "── 5/5  column inventory, for bin/compare-schemas.sh ──"
in_db psql "$CLOUD_URL" -Atc "
  SELECT string_agg(format('%s.%s.%s:%s', table_schema, table_name, column_name, data_type), E'\n'
                    ORDER BY table_schema, table_name, column_name)
    FROM information_schema.columns
   WHERE table_schema IN ('public','marketing');
" > "$OUT_DIR/columns-cloud.txt"
echo "   $(wc -l < "$OUT_DIR/columns-cloud.txt") column(s) recorded"

echo
echo "Export complete: $OUT_DIR"
echo "  app-data.dump        rows for public + marketing"
echo "  auth-users.sql       restore BEFORE auth-identities.sql"
echo "  auth-identities.sql"
echo "  row-estimates.txt    per-table counts to verify against"
echo "  row-exact.txt        exact counts for calls/organizations/users/memberships"
echo "  columns-cloud.txt    input to bin/compare-schemas.sh"
echo
echo "This directory now holds every tenant's data. Delete it once the cutover"
echo "is verified, and do not copy it anywhere that is not encrypted."
