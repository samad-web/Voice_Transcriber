#!/usr/bin/env bash
#
# Nightly backup of the self-hosted database: on-box to MinIO, off-box to
# wherever OFFSITE_* points.
#
#   bash bin/backup.sh
#
# Install as a cron job (see the runbook, "Backups"):
#   15 2 * * *  cd /opt/aura/platform/supabase/selfhost && bash bin/backup.sh >> /var/log/aura-backup.log 2>&1
#
# ── WHAT MOVING OFF SUPABASE ACTUALLY COST ───────────────────────────────────
#
# This script. Managed Postgres was doing backups; nothing does them now unless
# this runs and unless bin/restore-test.sh has actually been run at least once.
# A backup nobody has restored is a belief, not a backup.
#
# ── WHY THE ON-BOX COPY IS NOT ENCRYPTED AND THE OFFSITE COPY IS ─────────────
#
# The on-box copy lands in the same MinIO that already stores every call
# recording, on the same disk as the live database. Encrypting it would protect
# the data from someone who already has root on the box - i.e. nobody. The
# offsite copy leaves this trust boundary, so it is encrypted before it goes.
#
# If you set OFFSITE_PASSPHRASE, WRITE IT DOWN WHEREVER JWT_SECRET AND
# CRM_SECRET_KEY LIVE. Losing it makes every offsite backup unreadable, and you
# will find out at the worst possible moment.
set -euo pipefail

cd "$(dirname "$0")/.."

DB_CONTAINER="${DB_CONTAINER:-aura-supabase-db}"
ENV_FILE="${ENV_FILE:-.env.selfhost}"
NETWORK="${NETWORK:-aura_default}"

# On-box destination. The bucket is created if missing.
MINIO_ALIAS_URL="${MINIO_ALIAS_URL:-http://minio:9000}"
BACKUP_BUCKET="${BACKUP_BUCKET:-aura-backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

# Offsite destination. Any S3-compatible endpoint. Leave OFFSITE_ENDPOINT unset
# to skip - the script says so loudly rather than pretending it ran.
OFFSITE_ENDPOINT="${OFFSITE_ENDPOINT:-}"
OFFSITE_BUCKET="${OFFSITE_BUCKET:-}"
OFFSITE_ACCESS_KEY="${OFFSITE_ACCESS_KEY:-}"
OFFSITE_SECRET_KEY="${OFFSITE_SECRET_KEY:-}"
OFFSITE_PASSPHRASE="${OFFSITE_PASSPHRASE:-}"
OFFSITE_RETAIN_DAYS="${OFFSITE_RETAIN_DAYS:-90}"

[ -f "$ENV_FILE" ] || { echo "FATAL: $ENV_FILE not found." >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "./$ENV_FILE"; set +a

: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD missing from $ENV_FILE}"
PGDB="${POSTGRES_DB:-postgres}"

# The platform's own MinIO credentials, for the on-box copy.
PROD_ENV="${PROD_ENV:-/opt/aura/platform/.env.production}"
if [ -f "$PROD_ENV" ]; then
  S3_ACCESS_KEY_ID=$(grep -E '^S3_ACCESS_KEY_ID=' "$PROD_ENV" | head -1 | cut -d= -f2-)
  S3_SECRET_ACCESS_KEY=$(grep -E '^S3_SECRET_ACCESS_KEY=' "$PROD_ENV" | head -1 | cut -d= -f2-)
fi
: "${S3_ACCESS_KEY_ID:?set S3_ACCESS_KEY_ID or make $PROD_ENV readable}"
: "${S3_SECRET_ACCESS_KEY:?set S3_SECRET_ACCESS_KEY or make $PROD_ENV readable}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
# The dump is every tenant's data in plaintext. Nobody else on the box reads it,
# and it is removed on every exit path including failure.
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

echo "── dumping $PGDB at $STAMP ──"

# Globals first: roles and their passwords. Without these a restore comes back
# with the tables but no aura_app / aura_marketing, and nothing can connect.
# --no-role-passwords would make this file safe to read but useless to restore
# from, so it is included and the file is treated as a secret.
docker exec -i "$DB_CONTAINER" pg_dumpall -U postgres --globals-only \
  > "$WORK/globals-$STAMP.sql"

# The whole database, custom format: schema, data, and the auth schema in one
# artefact. Restores with pg_restore, filterable, parallelisable.
docker exec -i "$DB_CONTAINER" pg_dump -U postgres -d "$PGDB" -Fc \
  > "$WORK/db-$STAMP.dump"

dump_bytes=$(wc -c < "$WORK/db-$STAMP.dump")
echo "   db-$STAMP.dump  $(numfmt --to=iec "$dump_bytes" 2>/dev/null || echo "$dump_bytes bytes")"

# A pg_dump that fails partway can still exit 0 in a pipeline; a custom-format
# dump that pg_restore cannot list is not a backup. Check before shipping it.
# `pg_restore -l` reads a custom-format archive on stdin, so this reuses the
# database container rather than pulling a second Postgres image.
if ! docker exec -i "$DB_CONTAINER" pg_restore --list < "$WORK/db-$STAMP.dump" > /dev/null 2>&1; then
  echo "FATAL: the dump is not readable by pg_restore. Not uploading a corrupt backup." >&2
  exit 1
fi
echo "   dump verified readable by pg_restore"

# Tiny manifest so a human can tell at a glance whether a backup is plausible
# without restoring it first.
docker exec -i "$DB_CONTAINER" psql -U postgres -d "$PGDB" -Atc "
  SELECT 'taken_at=$STAMP'
      || E'\ncalls=' || (SELECT count(*) FROM public.calls)
      || E'\norganizations=' || (SELECT count(*) FROM public.organizations)
      || E'\nauth_users=' || (SELECT count(*) FROM auth.users)
      || E'\nmigrations=' || (SELECT count(*) FROM public.schema_migrations);
" > "$WORK/manifest-$STAMP.txt"
sed 's/^/   /' "$WORK/manifest-$STAMP.txt"

# The on-box MinIO, reached over the aura compose network. Credentials go in via
# MC_HOST_<alias> rather than `mc alias set`, so nothing is written to a config
# file and nothing lands in the process list.
mc() {
  docker run --rm -i --network "$NETWORK" \
    -e MC_HOST_local="http://${S3_ACCESS_KEY_ID}:${S3_SECRET_ACCESS_KEY}@${MINIO_ALIAS_URL#http://}" \
    -v "$WORK:/w" \
    minio/mc:latest "$@"
}

# The offsite target. A separate function, because it needs a different
# credential and must never be invoked when OFFSITE_ENDPOINT is unset.
mc_offsite() {
  docker run --rm -i \
    -e MC_HOST_offsite="$OFFSITE_ENDPOINT_WITH_CREDS" \
    -v "$WORK:/w" \
    minio/mc:latest "$@"
}

echo
echo "── on-box copy -> minio/$BACKUP_BUCKET ──"
mc mb --ignore-existing "local/$BACKUP_BUCKET" >/dev/null
mc cp "/w/db-$STAMP.dump"       "local/$BACKUP_BUCKET/db-$STAMP.dump" >/dev/null
mc cp "/w/globals-$STAMP.sql"   "local/$BACKUP_BUCKET/globals-$STAMP.sql" >/dev/null
mc cp "/w/manifest-$STAMP.txt"  "local/$BACKUP_BUCKET/manifest-$STAMP.txt" >/dev/null
echo "   uploaded 3 object(s)"

# Retention. `mc rm --older-than` is calculated server-side from object age.
mc rm --recursive --force --older-than "${RETAIN_DAYS}d" "local/$BACKUP_BUCKET/" >/dev/null 2>&1 || true
echo "   pruned objects older than ${RETAIN_DAYS}d"

echo
if [ -z "$OFFSITE_ENDPOINT" ]; then
  echo "── OFFSITE COPY SKIPPED ──"
  echo "   OFFSITE_ENDPOINT is unset, so this backup exists only on the machine it"
  echo "   is a backup OF. That protects against a bad migration or a wrong DELETE,"
  echo "   and against nothing else. Losing the VPS loses the database and every"
  echo "   backup of it together."
else
  echo "── offsite copy -> $OFFSITE_ENDPOINT/$OFFSITE_BUCKET ──"
  : "${OFFSITE_BUCKET:?set OFFSITE_BUCKET}"
  : "${OFFSITE_ACCESS_KEY:?set OFFSITE_ACCESS_KEY}"
  : "${OFFSITE_SECRET_KEY:?set OFFSITE_SECRET_KEY}"
  : "${OFFSITE_PASSPHRASE:?set OFFSITE_PASSPHRASE - this copy leaves the box and must be encrypted}"

  command -v gpg >/dev/null 2>&1 || {
    echo "FATAL: gpg is not installed, and this copy must not leave the box in the clear." >&2
    echo "  apt-get install -y gnupg" >&2
    exit 1
  }

  for f in "db-$STAMP.dump" "globals-$STAMP.sql"; do
    gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
        --passphrase "$OFFSITE_PASSPHRASE" \
        --output "$WORK/$f.gpg" "$WORK/$f"
  done
  echo "   encrypted with AES256 (gpg symmetric)"

  scheme="${OFFSITE_ENDPOINT%%://*}"
  hostpath="${OFFSITE_ENDPOINT#*://}"
  OFFSITE_ENDPOINT_WITH_CREDS="${scheme}://${OFFSITE_ACCESS_KEY}:${OFFSITE_SECRET_KEY}@${hostpath}"

  mc_offsite mb --ignore-existing "offsite/$OFFSITE_BUCKET" >/dev/null 2>&1 || true
  mc_offsite cp "/w/db-$STAMP.dump.gpg"     "offsite/$OFFSITE_BUCKET/db-$STAMP.dump.gpg" >/dev/null
  mc_offsite cp "/w/globals-$STAMP.sql.gpg" "offsite/$OFFSITE_BUCKET/globals-$STAMP.sql.gpg" >/dev/null
  mc_offsite cp "/w/manifest-$STAMP.txt"    "offsite/$OFFSITE_BUCKET/manifest-$STAMP.txt" >/dev/null
  echo "   uploaded 3 object(s)"

  mc_offsite rm --recursive --force --older-than "${OFFSITE_RETAIN_DAYS}d" \
     "offsite/$OFFSITE_BUCKET/" >/dev/null 2>&1 || true
  echo "   pruned objects older than ${OFFSITE_RETAIN_DAYS}d"
fi

echo
echo "Backup $STAMP complete."
echo
echo "When did you last actually RESTORE one?  bash bin/restore-test.sh"
