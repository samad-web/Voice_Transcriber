#!/usr/bin/env bash
#
# Mirror the call recordings off the box (doc 49 P4-C).
#
#   bash bin/backup-recordings.sh            # mirror new/changed objects
#   bash bin/backup-recordings.sh --dry-run  # say what would transfer
#   bash bin/backup-recordings.sh --size     # just report the sizes, both ends
#
# Cron, after the database backup rather than alongside it:
#   45 2 * * *  cd /opt/aura/platform/supabase/selfhost && bash bin/backup-recordings.sh >> /var/log/aura-backup.log 2>&1
#
# ── WHY THIS IS A SEPARATE SCRIPT FROM backup.sh ─────────────────────────────
#
# Two reasons, both about not letting the big slow thing break the small
# critical one.
#
# The database dump is tens of megabytes and finishes in seconds. The
# recordings are 61 GB today and grow every day. Folding them into backup.sh
# would mean a nightly job whose runtime is dominated by object storage, and
# whose `set -e` would abandon the database backup if a single object transfer
# failed. The database is the thing you cannot rebuild; it goes first, on its
# own, and finishes.
#
# They also have different RECOVERY semantics. Losing the database loses
# everything - every call row, every transcript, every lead. Losing the
# recordings loses the audio behind transcripts that still exist, which is
# worse than it sounds (a transcript whose audio is gone cannot be re-verified,
# re-processed, or defended in a dispute) but is not the same emergency.
#
# ── WHY mc mirror AND NOT A TAR ──────────────────────────────────────────────
#
# DEPLOYMENT.md §8 has a tar recipe, and at 61 GB a nightly tar is 61 GB over
# the wire every night for a dataset that only ever appends. `mc mirror`
# transfers what is new. The trade is that there are no point-in-time snapshots
# - a mirror is the current state - which is the right answer here because a
# recording is immutable once written. Nothing edits last Tuesday's audio, so
# there is nothing a snapshot would preserve that the mirror loses.
#
# `--remove` is deliberately NOT passed. If the retention job (P8-C) deletes
# audio locally, the offsite copy keeps it until its own lifecycle rule expires
# it. That is the conservative direction, and the costly one - see the warning
# at the end.
#
# ── ENCRYPTION, HONESTLY ─────────────────────────────────────────────────────
#
# The database dump is gpg-encrypted before it leaves, because it is one file.
# 61 GB of individually-encrypted objects would be unusable: every restore
# would be a decrypt-the-world operation, and `mc mirror`'s incremental
# comparison stops working once the local and remote bytes differ by design.
#
# So recordings rely on the TARGET's encryption at rest, and this script
# refuses to run until somebody says out loud that the target has it. That is a
# weaker guarantee than the dump's and it is stated rather than hidden:
# anybody with credentials to that bucket has the audio. Pick a provider whose
# bucket you can make private and server-side-encrypted, set
# RECORDINGS_OFFSITE_SSE=1, and keep those credentials as tightly as JWT_SECRET.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env.selfhost}"
NETWORK="${NETWORK:-aura_default}"
MINIO_ALIAS_URL="${MINIO_ALIAS_URL:-http://minio:9000}"
RECORDINGS_BUCKET="${RECORDINGS_BUCKET:-aura-recordings}"
PROD_ENV="${PROD_ENV:-/opt/aura/platform/.env.production}"

DRY=0
SIZE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --size)    SIZE_ONLY=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && { set -a; . "./$ENV_FILE"; set +a; }

if [ -f "$PROD_ENV" ]; then
  S3_ACCESS_KEY_ID=$(grep -E '^S3_ACCESS_KEY_ID=' "$PROD_ENV" | head -1 | cut -d= -f2-)
  S3_SECRET_ACCESS_KEY=$(grep -E '^S3_SECRET_ACCESS_KEY=' "$PROD_ENV" | head -1 | cut -d= -f2-)
  # Reuse the database backup's offsite target by default: one place to lose,
  # one credential to rotate, one bill.
  : "${OFFSITE_ENDPOINT:=$(grep -E '^OFFSITE_ENDPOINT=' "$PROD_ENV" | head -1 | cut -d= -f2-)}"
fi
: "${S3_ACCESS_KEY_ID:?set S3_ACCESS_KEY_ID or make $PROD_ENV readable}"
: "${S3_SECRET_ACCESS_KEY:?set S3_SECRET_ACCESS_KEY or make $PROD_ENV readable}"

RECORDINGS_OFFSITE_BUCKET="${RECORDINGS_OFFSITE_BUCKET:-${OFFSITE_BUCKET:-}-recordings}"

mc_local() {
  docker run --rm -i --network "$NETWORK" \
    -e MC_HOST_local="http://${S3_ACCESS_KEY_ID}:${S3_SECRET_ACCESS_KEY}@${MINIO_ALIAS_URL#http://}" \
    minio/mc:latest "$@"
}

echo "── what is on the box ──"
# `du` on a bucket is a full listing; at 9,305 objects that is seconds, and it
# is the number that decides whether the transfer below is affordable.
mc_local du "local/$RECORDINGS_BUCKET" | sed 's/^/   /'

if [ "$SIZE_ONLY" = "1" ]; then
  if [ -n "${OFFSITE_ENDPOINT:-}" ] && [ -n "${OFFSITE_ACCESS_KEY:-}" ]; then
    scheme="${OFFSITE_ENDPOINT%%://*}"; hostpath="${OFFSITE_ENDPOINT#*://}"
    echo "── what is off the box ──"
    docker run --rm -i \
      -e MC_HOST_offsite="${scheme}://${OFFSITE_ACCESS_KEY}:${OFFSITE_SECRET_KEY}@${hostpath}" \
      minio/mc:latest du "offsite/$RECORDINGS_OFFSITE_BUCKET" 2>/dev/null | sed 's/^/   /' \
      || echo "   (nothing there yet)"
  fi
  exit 0
fi

if [ -z "${OFFSITE_ENDPOINT:-}" ]; then
  cat >&2 <<'MSG'

── RECORDINGS ARE NOT BACKED UP ──
   OFFSITE_ENDPOINT is unset, so every call recording exists in exactly one
   place: the `miniodata` volume on this machine, on the same disk as the
   database and as the database's own backups.

   A disk failure, a billing lapse, a `rm` in the wrong directory or a provider
   dispute loses the audio behind every transcript at once. The transcripts
   would survive in the database dump and would no longer be verifiable against
   anything.

   Set OFFSITE_ENDPOINT, OFFSITE_ACCESS_KEY, OFFSITE_SECRET_KEY and
   RECORDINGS_OFFSITE_BUCKET in .env.selfhost. See DEPLOYMENT.md §11.
MSG
  exit 1
fi

: "${OFFSITE_ACCESS_KEY:?set OFFSITE_ACCESS_KEY}"
: "${OFFSITE_SECRET_KEY:?set OFFSITE_SECRET_KEY}"
: "${RECORDINGS_OFFSITE_BUCKET:?set RECORDINGS_OFFSITE_BUCKET}"

if [ "${RECORDINGS_OFFSITE_SSE:-0}" != "1" ]; then
  cat >&2 <<'MSG'

── REFUSING TO MIRROR ──
   RECORDINGS_OFFSITE_SSE is not 1.

   Unlike the database dump, these objects are NOT encrypted by this script -
   61 GB of individually gpg-encrypted files cannot be mirrored incrementally
   or restored selectively, so recordings rely on the TARGET's encryption at
   rest instead. That is a weaker guarantee and it is your decision to make,
   not this script's to assume.

   Before setting RECORDINGS_OFFSITE_SSE=1, confirm at the provider that:
     * the bucket is PRIVATE, with no public or anonymous read;
     * server-side encryption at rest is ON;
     * the credentials above are scoped to this bucket and nothing else;
     * the region satisfies whatever a customer contract says about residency.

   This is customer call audio under a signed DPA
   (Build docs/legal/03_DATA_PROCESSING_AGREEMENT.md). Treat the credentials
   exactly as you treat JWT_SECRET.
MSG
  exit 1
fi

scheme="${OFFSITE_ENDPOINT%%://*}"
hostpath="${OFFSITE_ENDPOINT#*://}"
OFFSITE_WITH_CREDS="${scheme}://${OFFSITE_ACCESS_KEY}:${OFFSITE_SECRET_KEY}@${hostpath}"

mc_both() {
  # Both aliases in one container, because `mc mirror` needs to see the source
  # and the destination at once. The local side needs the compose network; the
  # offsite side needs the internet, which that network also provides.
  docker run --rm -i --network "$NETWORK" \
    -e MC_HOST_local="http://${S3_ACCESS_KEY_ID}:${S3_SECRET_ACCESS_KEY}@${MINIO_ALIAS_URL#http://}" \
    -e MC_HOST_offsite="$OFFSITE_WITH_CREDS" \
    minio/mc:latest "$@"
}

echo
echo "── mirroring -> offsite/$RECORDINGS_OFFSITE_BUCKET ──"
mc_both mb --ignore-existing "offsite/$RECORDINGS_OFFSITE_BUCKET" >/dev/null 2>&1 || true

# --overwrite is NOT passed: an object already there with the same size is
# skipped, which is what makes a nightly run cheap. Recordings are immutable
# once written, so "already there" and "identical" are the same statement.
#
# --watch is NOT passed either: this is a cron job, not a daemon. A daemon
# holding a connection to a third party for weeks is a thing that fails
# silently, which is the failure mode this whole document is about.
if [ "$DRY" = "1" ]; then
  mc_both mirror --dry-run "local/$RECORDINGS_BUCKET" "offsite/$RECORDINGS_OFFSITE_BUCKET" \
    | tail -20 | sed 's/^/   /'
  echo "   (dry run - nothing transferred)"
  exit 0
fi

mc_both mirror "local/$RECORDINGS_BUCKET" "offsite/$RECORDINGS_OFFSITE_BUCKET" 2>&1 \
  | tail -5 | sed 's/^/   /'

echo
echo "Recordings mirror complete."
echo
cat <<'MSG'
Two things this does NOT do, stated so nobody assumes otherwise:

  1. It is a MIRROR, not a history. There are no point-in-time snapshots of the
     audio - correct for immutable objects, but it means a bug that deleted
     recordings locally would propagate on the next run unless --remove stays
     off, which it does.

  2. It never deletes from the offsite copy. When the retention job (P8-C)
     removes audio past a tenant's window locally, the offsite copy keeps it
     until the TARGET's own lifecycle rule expires it. Set that rule at the
     provider to match the longest retention tier you sell, or the bill grows
     for data you have promised a customer you deleted - which is a compliance
     problem as well as a cost one.
MSG
