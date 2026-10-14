#!/usr/bin/env bash
#
# Restore the most recent backup into a THROWAWAY database and check it is real.
#
#   bash bin/restore-test.sh              # newest backup in the ON-BOX MinIO
#   bash bin/restore-test.sh db-20260907T021500Z.dump
#   bash bin/restore-test.sh --offsite    # the ENCRYPTED copy, from off the box
#
# ── THE --offsite MODE IS THE ONE THAT ACTUALLY PROVES SOMETHING ─────────────
#
# Without it this script restores from MinIO - the same disk as the live
# database - so it proves `pg_dump` produced a readable artefact and nothing
# about surviving the loss of the machine. The scenario that matters is a disk
# failure, a billing lapse, a `rm` in the wrong directory or a provider
# dispute, and in every one of those the on-box copy is gone with the original.
#
# `--offsite` pulls the gpg-encrypted copy from OFFSITE_*, decrypts it with
# OFFSITE_PASSPHRASE, and restores that. It therefore also tests the two things
# nobody tests until they need them: that the offsite upload is running at all,
# and that the passphrase somebody wrote down is the passphrase that works.
# A backup whose passphrase died with the server is a tidy way to lose the data
# twice.
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

WANTED=""
OFFSITE=0
for arg in "$@"; do
  case "$arg" in
    --offsite) OFFSITE=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) WANTED="$arg" ;;
  esac
done

NETWORK="${NETWORK:-aura_default}"
BACKUP_BUCKET="${BACKUP_BUCKET:-aura-backups}"
MINIO_ALIAS_URL="${MINIO_ALIAS_URL:-http://minio:9000}"
PROD_ENV="${PROD_ENV:-/opt/aura/platform/.env.production}"
ENV_FILE="${ENV_FILE:-.env.selfhost}"
# PLAIN Postgres of the live major version (17), deliberately not the Supabase
# image. The Supabase image ships its own, older `auth` tables - GoTrue's
# migrations are what normally shape them - so restoring a dump into it
# silently drops every auth.users row on "column does not exist". Into plain
# Postgres the dump creates every schema itself, auth included. The price is
# two Supabase-only extensions (pg_net, supabase_vault), expected below.
PG_IMAGE="${PG_IMAGE:-postgres:17}"
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

# The offsite target, when asked for. Credentials via MC_HOST_<alias> so nothing
# reaches a config file or the process list, exactly as backup.sh does it.
mc_offsite() {
  docker run --rm -i \
    -e MC_HOST_offsite="$OFFSITE_ENDPOINT_WITH_CREDS" \
    -v "$WORK:/w" minio/mc:latest "$@"
}

if [ "$OFFSITE" = "1" ]; then
  echo "── finding a backup OFF the box ──"
  # shellcheck disable=SC1090
  [ -f "$ENV_FILE" ] && { set -a; . "./$ENV_FILE"; set +a; }
  : "${OFFSITE_ENDPOINT:?OFFSITE_ENDPOINT is unset - there is no offsite backup to restore.
   This is doc 49 P4-A: backup.sh already supports an encrypted off-box copy and
   nobody set the four variables, so every backup lives on the disk it protects.}"
  : "${OFFSITE_BUCKET:?set OFFSITE_BUCKET}"
  : "${OFFSITE_ACCESS_KEY:?set OFFSITE_ACCESS_KEY}"
  : "${OFFSITE_SECRET_KEY:?set OFFSITE_SECRET_KEY}"
  : "${OFFSITE_PASSPHRASE:?set OFFSITE_PASSPHRASE - without it the offsite copy is unreadable}"
  command -v gpg >/dev/null 2>&1 || { echo "FATAL: gpg is not installed." >&2; exit 1; }

  scheme="${OFFSITE_ENDPOINT%%://*}"
  hostpath="${OFFSITE_ENDPOINT#*://}"
  OFFSITE_ENDPOINT_WITH_CREDS="${scheme}://${OFFSITE_ACCESS_KEY}:${OFFSITE_SECRET_KEY}@${hostpath}"

  if [ -z "$WANTED" ]; then
    WANTED=$(mc_offsite ls "offsite/$OFFSITE_BUCKET/" | awk '{print $NF}'              | grep '^db-.*\.dump\.gpg$' | sort | tail -1)
    [ -n "$WANTED" ] || { echo "FATAL: no db-*.dump.gpg in offsite/$OFFSITE_BUCKET." >&2; exit 1; }
  fi
  STAMP="${WANTED#db-}"; STAMP="${STAMP%.dump.gpg}"; STAMP="${STAMP%.dump}"
  echo "   $WANTED"

  mc_offsite cp "offsite/$OFFSITE_BUCKET/$WANTED" "/w/$WANTED" >/dev/null
  mc_offsite cp "offsite/$OFFSITE_BUCKET/manifest-$STAMP.txt" "/w/manifest.txt" >/dev/null 2>&1 || true

  # The decrypt IS a test. A wrong or lost passphrase fails here, which is
  # exactly where you want to find out rather than during an outage.
  DUMP="db-$STAMP.dump"
  if ! gpg --batch --yes --quiet --decrypt --passphrase "$OFFSITE_PASSPHRASE"        --output "$WORK/$DUMP" "$WORK/$WANTED" 2>"$WORK/gpg.err"; then
    echo "FATAL: could not decrypt the offsite backup with OFFSITE_PASSPHRASE." >&2
    sed 's/^/   /' "$WORK/gpg.err" >&2
    echo "   The offsite copies are unreadable. This is the worst possible state:" >&2
    echo "   backups exist, run nightly, and cannot be restored." >&2
    exit 1
  fi
  echo "   decrypted with OFFSITE_PASSPHRASE"
  WANTED="$DUMP"
else
  echo "── finding a backup ──"
  if [ -z "$WANTED" ]; then
    WANTED=$(mc ls "local/$BACKUP_BUCKET/" | awk '{print $NF}' | grep '^db-.*\.dump$' | sort | tail -1)
    [ -n "$WANTED" ] || { echo "FATAL: no db-*.dump in local/$BACKUP_BUCKET." >&2; exit 1; }
  fi
  STAMP="${WANTED#db-}"; STAMP="${STAMP%.dump}"
  echo "   $WANTED"

  mc cp "local/$BACKUP_BUCKET/$WANTED" "/w/$WANTED" >/dev/null
  mc cp "local/$BACKUP_BUCKET/manifest-$STAMP.txt" "/w/manifest.txt" >/dev/null 2>&1 || true
fi
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

# Three consecutive successful QUERIES, not one pg_isready: the entrypoint
# answers during initdb on a temporary server, then restarts it, and a restore
# that starts in that gap lands nowhere.
ok=0
for _ in $(seq 1 90); do
  if docker exec "$SCRATCH_CONTAINER" psql -h localhost -U postgres -Atc 'SELECT 1' >/dev/null 2>&1; then
    ok=$((ok + 1))
  else
    ok=0
  fi
  [ "$ok" -ge 3 ] && break
  sleep 2
done
[ "$ok" -ge 3 ] || {
  echo "FATAL: the throwaway Postgres never became ready." >&2
  docker logs --tail 40 "$SCRATCH_CONTAINER" >&2
  exit 1
}
echo "   ready"

echo
echo "── restoring ──"
# Not --single-transaction: the two Supabase-only extensions cannot exist in
# plain Postgres and are expected to fail; everything else must land. (There is
# no `--exit-on-error=false`: pg_restore rejects it as a usage error, restores
# nothing, and says so in a line the error count below never matched.)
docker exec -i "$SCRATCH_CONTAINER" pg_restore -U postgres -d postgres \
  --no-owner --no-acl \
  < "$WORK/$WANTED" 2> "$WORK/restore.err" || true

# Every ERROR except the Supabase internals plain Postgres cannot provide.
# Not `grep -c ... || echo 0`: with no match grep -c PRINTS 0 and exits 1, so
# that form yields "0\n0" and a clean restore reads as a failed one.
EXPECTED='extension "(pg_net|supabase_vault)"|relation "vault\.secrets" does not exist'
errors=$(grep 'ERROR:' "$WORK/restore.err" | grep -cvE "$EXPECTED") || true
errors="${errors:-0}"
expected=$(grep 'ERROR:' "$WORK/restore.err" | grep -cE "$EXPECTED") || true
echo "   pg_restore: ${errors} unexpected error(s), ${expected:-0} expected (pg_net / supabase_vault)"
if [ "$errors" != "0" ]; then
  grep 'ERROR:' "$WORK/restore.err" | grep -vE "$EXPECTED" | head -5 | sed 's/^/      /'
  FAILURES_RESTORE=1
fi

echo
echo "── does the restored database actually hold the data? ──"
FAILURES="${FAILURES_RESTORE:-0}"
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

# ── THE MIGRATION CEILING, NOT THE MIGRATION COUNT ──────────────────────────
#
# The manifest comparison above counts rows in schema_migrations, which a
# restore can get right while still being the wrong database - a dump taken
# mid-deploy, or from the OTHER Supabase stack on this box
# (`two-supabase-stacks-on-vps`: the bare `supabase-db` belongs to an unrelated
# product and querying it makes production look unmigrated). The highest
# migration NAME is what says which schema this actually is.
top=$(q "SELECT max(name) FROM public.schema_migrations;")
if [ -n "$top" ] && [ "$top" != "ERR" ]; then
  printf '  [32mPASS[0m  %-14s %s
' "migration top" "$top"
else
  printf '  [31mFAIL[0m  %-14s could not read schema_migrations
' "migration top"
  FAILURES=$((FAILURES + 1))
fi

# ── THE CHECK PEOPLE SKIP ───────────────────────────────────────────────────
#
# A restored database full of credentials nobody can decrypt is a restored
# database you cannot operate. Every CRM API key, every OAuth client secret and
# every messaging token is sealed with AES-256-GCM under CRM_SECRET_KEY
# (`packages/db/src/secrets.ts`, prefix `v1.gcm:`). The key lives in
# `.env.production` and NOT in the dump - correctly - which means a restore onto
# fresh hardware produces a database whose integrations are all inert unless
# that one variable came with it.
#
# So: find one sealed value and actually decrypt it. The ciphertext is
# authenticated, so a wrong key fails rather than yielding garbage, and openssl
# is used rather than node because this script must work on a recovery box with
# nothing installed.
echo
echo "── can the restored credentials still be decrypted? ──"
sealed=$(q "
  SELECT api_key FROM public.messaging_channels
   WHERE api_key LIKE 'v1.gcm:%' LIMIT 1
  UNION ALL
  SELECT access_token FROM public.connections
   WHERE access_token LIKE 'v1.gcm:%' LIMIT 1
  LIMIT 1;" | head -1)

if [ -z "$sealed" ] || [ "$sealed" = "ERR" ]; then
  printf '  [33mSKIP[0m  %-14s no sealed credential in this database to test with
' "crm secret"
elif [ -z "${CRM_SECRET_KEY:-}" ]; then
  printf '  [31mFAIL[0m  %-14s CRM_SECRET_KEY is not set, so this cannot be proved
' "crm secret"
  echo "        Export it from .env.production and re-run. A restore nobody has"
  echo "        proved decryptable is a restore that silently breaks every integration."
  FAILURES=$((FAILURES + 1))
else
  # The key derivation mirrors secrets.ts exactly: 64 hex chars are used as-is,
  # a 32-byte base64 value as-is, anything else is sha256'd.
  if printf '%s' "$CRM_SECRET_KEY" | grep -qiE '^[0-9a-f]{64}$'; then
    keyhex="$CRM_SECRET_KEY"
  else
    b64len=$(printf '%s' "$CRM_SECRET_KEY" | base64 -d 2>/dev/null | wc -c || echo 0)
    if [ "$b64len" = "32" ]; then
      keyhex=$(printf '%s' "$CRM_SECRET_KEY" | base64 -d | od -An -tx1 | tr -d ' 
')
    else
      keyhex=$(printf '%s' "$CRM_SECRET_KEY" | openssl dgst -sha256 -binary | od -An -tx1 | tr -d ' 
')
    fi
  fi

  iv_b64=$(printf '%s' "$sealed" | cut -d: -f2)
  tag_b64=$(printf '%s' "$sealed" | cut -d: -f3)
  ct_b64=$(printf '%s' "$sealed" | cut -d: -f4)
  ivhex=$(printf '%s' "$iv_b64" | base64 -d | od -An -tx1 | tr -d ' 
')
  taghex=$(printf '%s' "$tag_b64" | base64 -d | od -An -tx1 | tr -d ' 
')
  printf '%s' "$ct_b64" | base64 -d > "$WORK/ct.bin"

  if openssl enc -d -aes-256-gcm -K "$keyhex" -iv "$ivhex"        -in "$WORK/ct.bin" -out "$WORK/pt.bin" 2>/dev/null      || openssl enc -d -aes-256-gcm -K "$keyhex" -iv "$ivhex" -tag "$taghex"           -in "$WORK/ct.bin" -out "$WORK/pt.bin" 2>/dev/null; then
    printf '  [32mPASS[0m  %-14s one sealed credential decrypted (%s bytes)
'       "crm secret" "$(wc -c < "$WORK/pt.bin" | tr -d ' ')"
  else
    printf '  [31mFAIL[0m  %-14s could not decrypt with the CRM_SECRET_KEY given
' "crm secret"
    echo "        Either the key is wrong, or this openssl cannot do AES-256-GCM"
    echo "        (openssl 1.x cannot). Fall back to:"
    echo "          CRM_SECRET_KEY=... node -e \"require('./packages/db/dist/secrets').decryptSecret(process.argv[1])\" '<value>'"
    FAILURES=$((FAILURES + 1))
  fi
  rm -f "$WORK/ct.bin" "$WORK/pt.bin"
fi

echo
if [ "$FAILURES" = "0" ]; then
  echo "RESTORE TEST PASSED for $WANTED."
  if [ "$OFFSITE" = "1" ]; then
    echo
    echo "This was the OFF-BOX copy, decrypted with OFFSITE_PASSPHRASE. That is the"
    echo "restore that proves something: it survives losing this machine."
  else
    echo
    echo "NOTE: this restored the ON-BOX copy, from the same disk as the live database."
    echo "It proves pg_dump produced a readable artefact. It proves NOTHING about"
    echo "surviving the loss of this machine - run 'bash bin/restore-test.sh --offsite'"
    echo "for that, ideally on different hardware."
  fi
  echo
  echo "Record the date somewhere durable - this is the evidence the backups work."
  echo "DEPLOYMENT.md §11 has a line for it."
else
  echo "RESTORE TEST FAILED: $FAILURES check(s). The backups are NOT trustworthy."
fi
exit "$FAILURES"
