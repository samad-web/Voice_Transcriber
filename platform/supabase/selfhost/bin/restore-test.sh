#!/usr/bin/env bash
#
# Restore the most recent backup into a THROWAWAY database and check it is real.
#
#   bash bin/restore-test.sh              # newest backup in MinIO
#   bash bin/restore-test.sh db-20260907T021500Z.dump
#
# DB_LATENCY_MIGRATION.md makes this a precondition of the cutover, not a
# follow-up: "Do not start the cutover until a restore has actually been
# performed once." Run it then, and on a schedule afterwards.
#
# ── IT CANNOT TOUCH PRODUCTION ───────────────────────────────────────────────
#
# The restore target is a brand-new postgres container on its own throwaway
# volume, with no network path to the aura stack. It is removed on every exit
# path. Nothing here connects to supabase-db except to read the backup out of
# MinIO, and that is a read.
set -euo pipefail

cd "$(dirname "$0")/.."

WANTED="${1:-}"
NETWORK="${NETWORK:-aura_default}"
BACKUP_BUCKET="${BACKUP_BUCKET:-aura-backups}"
MINIO_ALIAS_URL="${MINIO_ALIAS_URL:-http://minio:9000}"
PROD_ENV="${PROD_ENV:-/opt/aura/platform/.env.production}"
# Matches the image the live stack runs, so a restore that works here works there.
PG_IMAGE="${PG_IMAGE:-supabase/postgres:17.6.1.136}"
SCRATCH_CONTAINER="aura-restore-test-$$"

if [ -f "$PROD_ENV" ]; then
  S3_ACCESS_KEY_ID=$(grep -E '^S3_ACCESS_KEY_ID=' "$PROD_ENV" | head -1 | cut -d= -f2-)
  S3_SECRET_ACCESS_KEY=$(grep -E '^S3_SECRET_ACCESS_KEY=' "$PROD_ENV" | head -1 | cut -d= -f2-)
fi
: "${S3_ACCESS_KEY_ID:?set S3_ACCESS_KEY_ID or make $PROD_ENV readable}"
: "${S3_SECRET_ACCESS_KEY:?set S3_SECRET_ACCESS_KEY or make $PROD_ENV readable}"

WORK="$(mktemp -d)"
chmod 700 "$WORK"

cleanup() {
  docker rm -f "$SCRATCH_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mc() {
  docker run --rm -i --network "$NETWORK" \
    -e MC_HOST_local="http://${S3_ACCESS_KEY_ID}:${S3_SECRET_ACCESS_KEY}@${MINIO_ALIAS_URL#http://}" \
    -v "$WORK:/w" minio/mc:latest "$@"
}

echo "── finding a backup ──"
if [ -z "$WANTED" ]; then
  WANTED=$(mc ls "local/$BACKUP_BUCKET/" | awk '{print $NF}' | grep '^db-.*\.dump$' | sort | tail -1)
  [ -n "$WANTED" ] || { echo "FATAL: no db-*.dump in local/$BACKUP_BUCKET." >&2; exit 1; }
fi
STAMP="${WANTED#db-}"; STAMP="${STAMP%.dump}"
echo "   $WANTED"

mc cp "local/$BACKUP_BUCKET/$WANTED" "/w/$WANTED" >/dev/null
mc cp "local/$BACKUP_BUCKET/manifest-$STAMP.txt" "/w/manifest.txt" >/dev/null 2>&1 || true
echo "   downloaded $(du -h "$WORK/$WANTED" | cut -f1)"

if [ -f "$WORK/manifest.txt" ]; then
  echo "   manifest recorded at backup time:"
  sed 's/^/      /' "$WORK/manifest.txt"
fi

echo
echo "── starting a throwaway Postgres (no network, removed on exit) ──"
# --network none: it must be impossible for this to reach the live stack.
docker run -d --name "$SCRATCH_CONTAINER" --network none \
  -e POSTGRES_PASSWORD=restore-test-throwaway \
  -e POSTGRES_DB=postgres \
  "$PG_IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$SCRATCH_CONTAINER" pg_isready -U postgres -h localhost >/dev/null 2>&1; then break; fi
  sleep 2
done
docker exec "$SCRATCH_CONTAINER" pg_isready -U postgres -h localhost >/dev/null 2>&1 || {
  echo "FATAL: the throwaway Postgres never became ready." >&2
  docker logs --tail 40 "$SCRATCH_CONTAINER" >&2
  exit 1
}
echo "   ready"

echo
echo "── restoring ──"
# Not --single-transaction: a full-database restore into a Supabase image emits
# some statements the image has already applied (extensions, supabase roles), and
# those are expected to fail harmlessly. Errors are counted instead, and judged
# below by whether the DATA arrived.
docker exec -i "$SCRATCH_CONTAINER" pg_restore \
  --dbname="postgresql://postgres:restore-test-throwaway@localhost:5432/postgres" \
  --no-owner --no-acl --exit-on-error=false \
  < "$WORK/$WANTED" 2> "$WORK/restore.err" || true

errors=$(grep -c '^pg_restore: error' "$WORK/restore.err" 2>/dev/null || echo 0)
echo "   pg_restore reported $errors error line(s)"
if [ "$errors" != "0" ]; then
  echo "   first few:"
  grep '^pg_restore: error' "$WORK/restore.err" | head -5 | sed 's/^/      /'
fi

echo
echo "── does the restored database actually hold the data? ──"
FAILURES=0
q() { docker exec -i "$SCRATCH_CONTAINER" psql -U postgres -d postgres -Atc "$1" 2>/dev/null || echo "ERR"; }

check() { # name expected actual
  if [ "$3" = "$2" ]; then
    printf '  \033[32mPASS\033[0m  %-14s %s\n' "$1" "$3"
  else
    printf '  \033[31mFAIL\033[0m  %-14s %s (backup manifest said %s)\n' "$1" "$3" "$2"
    FAILURES=$((FAILURES + 1))
  fi
}

if [ -f "$WORK/manifest.txt" ]; then
  for key in calls organizations auth_users migrations; do
    expected=$(grep "^$key=" "$WORK/manifest.txt" | cut -d= -f2 || true)
    [ -n "$expected" ] || continue
    case "$key" in
      calls)         actual=$(q "SELECT count(*) FROM public.calls;") ;;
      organizations) actual=$(q "SELECT count(*) FROM public.organizations;") ;;
      auth_users)    actual=$(q "SELECT count(*) FROM auth.users;") ;;
      migrations)    actual=$(q "SELECT count(*) FROM public.schema_migrations;") ;;
    esac
    check "$key" "$expected" "$actual"
  done
else
  echo "  (no manifest for this backup - reporting counts without comparison)"
  printf '        calls=%s organizations=%s auth_users=%s\n' \
    "$(q 'SELECT count(*) FROM public.calls;')" \
    "$(q 'SELECT count(*) FROM public.organizations;')" \
    "$(q 'SELECT count(*) FROM auth.users;')"
fi

# Row counts alone would pass on a database whose tenant isolation did not
# survive the round trip. RLS is the property that matters most here.
rls_missing=$(q "
  SELECT count(*) FROM pg_tables t
   WHERE t.schemaname = 'public'
     AND EXISTS (SELECT 1 FROM information_schema.columns c
                  WHERE c.table_schema='public' AND c.table_name=t.tablename
                    AND c.column_name='org_id')
     AND NOT EXISTS (SELECT 1 FROM pg_class k
                      JOIN pg_namespace n ON n.oid = k.relnamespace
                     WHERE n.nspname='public' AND k.relname=t.tablename
                       AND k.relrowsecurity AND k.relforcerowsecurity);
")
if [ "$rls_missing" = "0" ]; then
  printf '  \033[32mPASS\033[0m  %-14s every org_id table has FORCE RLS\n' "rls"
else
  printf '  \033[31mFAIL\033[0m  %-14s %s org_id table(s) lost FORCE RLS in the restore\n' "rls" "$rls_missing"
  FAILURES=$((FAILURES + 1))
fi

echo
if [ "$FAILURES" = "0" ]; then
  echo "RESTORE TEST PASSED for $WANTED."
  echo "Record the date somewhere durable - this is the evidence the backups work."
else
  echo "RESTORE TEST FAILED: $FAILURES check(s). The backups are NOT trustworthy."
fi
exit "$FAILURES"
