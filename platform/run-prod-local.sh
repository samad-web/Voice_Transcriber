#!/usr/bin/env bash
#
# Run the LOCAL stack against the PRODUCTION Supabase database.
#
#   bash run-prod-local.sh
#
# Everything data-bearing points at production: Postgres (Supabase pooler) and
# object storage (storage.aura.sirahagents.com). Two things deliberately stay
# local because production's are compose-internal hostnames and unreachable
# from a workstation:
#
#   RABBITMQ_URL  production's is amqp://…@rabbitmq:5672. Consequence: this
#                 worker receives no wake-ups from the deployed API, so it acts
#                 ONLY through its database sweeps (retry, CRM outbox, reaper).
#   REDIS_URL     unused on the hot path.
#
# S3_ENDPOINT is overridden to the PUBLIC storage domain — production sets it to
# http://minio:9000, which resolves only inside the compose network. Without
# this override every recording read fails with NoSuchKey and the retry sweeper
# burns real calls' attempt budgets on a purely local misconfiguration.
#
# THIS WRITES TO PRODUCTION. The worker's loops act on live customer data:
# the reaper deletes past retention, the CRM outbox posts to customers' real
# endpoints, and the retry sweeper reprocesses failed calls. Stop it with Ctrl-C
# or the kill command in the README section at the bottom.
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env.production ]]; then
  echo "missing .env.production — nothing to point at" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env.production
set +a

# --- local infrastructure that production cannot expose ---------------------
export RABBITMQ_URL="amqp://aura:aura_dev_password@localhost:5672"
export REDIS_URL="redis://localhost:6379"

# --- reach production object storage from outside the compose network -------
export S3_ENDPOINT="https://${STORAGE_DOMAIN}"
export S3_PUBLIC_ENDPOINT="https://${STORAGE_DOMAIN}"

# --- serve the console from this machine, not the deployed origin -----------
export API_PORT=4000
export API_URL="http://localhost:4000"
export NEXT_PUBLIC_API_URL="http://localhost:4000"
export WEB_ORIGIN="http://localhost:3000"

echo "─────────────────────────────────────────────────────────────"
echo " LOCAL STACK → PRODUCTION DATABASE"
echo "   db      : $(sed -E 's#.*@##; s#/.*##' <<<"$APP_DATABASE_URL")"
echo "   storage : $S3_ENDPOINT"
echo "   queue   : localhost (production's is unreachable)"
echo "   asr     : ${GEMINI_ASR_MODEL:-gemini} (ASR_STUB=${ASR_STUB:-0})"
echo "   console : http://localhost:3000"
echo "─────────────────────────────────────────────────────────────"

exec pnpm dev
