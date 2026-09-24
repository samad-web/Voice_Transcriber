#!/usr/bin/env bash
#
# Prove the self-hosted stack is closed where it must be closed.
#
#   bash bin/verify-selfhost.sh
#
# Reads .env.selfhost from this directory. Every check here exists because its
# failure mode is SILENT - the stack comes up healthy, `docker ps` looks
# perfect, and the thing that is wrong is only visible to someone scanning the
# box or holding the anon key. Run it after the first start, after any change to
# docker-compose.aura.yml, and after every upstream refresh.
#
# Exit code is the number of failed checks.
set -uo pipefail

cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-.env.selfhost}"
DB_CONTAINER="${DB_CONTAINER:-aura-supabase-db}"

[ -f "$ENV_FILE" ] || { echo "FATAL: $ENV_FILE not found." >&2; exit 1; }

# shellcheck disable=SC1090
set -a; . "./$ENV_FILE"; set +a

FAILURES=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
info() { printf '        %s\n' "$1"; }

echo "══ 1. No container is published on a public interface ══"
#
# docker-compose.aura.yml uses `!override` to replace upstream's port lists.
# Upstream publishes the gateway on 8000 and, far worse, Postgres itself on
# ${POSTGRES_PORT}:5432 - both on 0.0.0.0. If the override silently failed to
# merge (wrong Compose version, a typo in the service name), nothing complains
# and the database is on the open internet.
#
# Checks reality via `docker ps`, not the compose config, because the config is
# what we believe and this is what is actually bound.
public_ports=$(docker ps --format '{{.Names}}\t{{.Ports}}' \
  | grep -E 'supabase|realtime-dev' \
  | grep -E '0\.0\.0\.0|\[::\]' || true)
if [ -z "$public_ports" ]; then
  pass "no supabase container publishes on 0.0.0.0"
else
  fail "container(s) published on a public interface:"
  echo "$public_ports" | sed 's/^/        /'
  info "docker-compose.aura.yml's \`ports: !override\` did not take."
  info "Needs Docker Compose >= 2.24. Check: docker compose version"
fi

echo
echo "══ 2. The anon key cannot read tenant data ══"
#
# THE CHECK THAT MATTERS MOST. The anon key is published in the console's
# browser bundle by design, so anyone can present it. Two independent things
# stop it reading: PGRST_DB_SCHEMAS excludes `public`, and
# 0007_supabase_hardening.sql revokes every privilege anon holds there.
#
# A 200 with rows here means every tenant's call transcripts are on a public
# endpoint. Treat it as an incident, not a config nit.
if [ -z "${ANON_KEY:-}" ]; then
  fail "ANON_KEY is not set in $ENV_FILE - cannot test"
else
  for table in calls organizations users contacts leads; do
    body=$(curl -s --max-time 15 \
      -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
      "${SUPABASE_PUBLIC_URL}/rest/v1/${table}?select=*&limit=1" 2>/dev/null || echo '<unreachable>')
    # A JSON array with anything in it is a leak. An error object is the pass.
    if printf '%s' "$body" | grep -qE '^\[\s*\{'; then
      fail "/rest/v1/$table returned ROWS to the anon key"
      info "$(printf '%s' "$body" | head -c 200)"
    else
      pass "/rest/v1/$table exposes nothing to anon"
    fi
  done
fi

echo
echo "══ 3. The database agrees - anon holds no privileges on public ══"
#
# The HTTP check above could pass merely because PostgREST is not routing that
# schema today. This asks Postgres directly, so the answer survives someone
# adding `public` back to PGRST_DB_SCHEMAS later.
granted=$(docker exec -i "$DB_CONTAINER" psql -U postgres -d "${POSTGRES_DB:-postgres}" -Atc "
  SELECT count(*) FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND grantee IN ('anon','authenticated');
" 2>/dev/null || echo "error")
if [ "$granted" = "0" ]; then
  pass "anon/authenticated hold 0 table privileges on schema public"
elif [ "$granted" = "error" ]; then
  fail "could not query the database (is $DB_CONTAINER running?)"
else
  fail "anon/authenticated hold $granted table privilege(s) on schema public"
  info "Re-apply packages/db/migrations/0007_supabase_hardening.sql."
fi

echo
echo "══ 4. RLS actually binds for the runtime role ══"
#
# aura_app is the only reason tenant isolation exists. If it ever becomes
# superuser or gains BYPASSRLS, every policy in the database silently stops
# applying and nothing else changes.
role_flags=$(docker exec -i "$DB_CONTAINER" psql -U postgres -d "${POSTGRES_DB:-postgres}" -Atc "
  SELECT coalesce((SELECT rolsuper::text || ',' || rolbypassrls::text
                     FROM pg_roles WHERE rolname = 'aura_app'), 'missing');
" 2>/dev/null || echo "error")
case "$role_flags" in
  "false,false") pass "aura_app is neither superuser nor BYPASSRLS" ;;
  "missing")     fail "the aura_app role does not exist - run packages/db/bootstrap-role.js" ;;
  "error")       fail "could not query pg_roles" ;;
  *)             fail "aura_app has rolsuper,rolbypassrls = $role_flags - RLS IS NOT BINDING" ;;
esac

echo
echo "══ 5. Sign-up is disabled ══"
#
# The console has no signup form, but GoTrue's endpoint is open unless told
# otherwise, and the anon key needed to call it is public. Upstream's default is
# `false` (i.e. signup ALLOWED), so this is easy to get wrong by omission.
signup=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  -X POST -H "apikey: ${ANON_KEY:-}" -H "content-type: application/json" \
  -d '{"email":"selfhost-verify-probe@example.invalid","password":"Probe-not-a-real-signup-1"}' \
  "${SUPABASE_PUBLIC_URL}/auth/v1/signup" 2>/dev/null || echo 000)
case "$signup" in
  200|201) fail "/auth/v1/signup accepted a registration (HTTP $signup) - set DISABLE_SIGNUP=true" ;;
  000)     fail "/auth/v1/signup unreachable - is the gateway routed?" ;;
  *)       pass "/auth/v1/signup refused the probe (HTTP $signup)" ;;
esac

echo
echo "══ 6. Studio is not open to the internet ══"
# Studio has no login of its own. The gateway's basic auth is the only thing in
# front of a full SQL console over every tenant's data.
studio=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  "${SUPABASE_PUBLIC_URL}/" 2>/dev/null || echo 000)
if [ "$studio" = "401" ]; then
  pass "Studio demands basic auth (HTTP 401)"
elif [ "$studio" = "000" ]; then
  fail "gateway root unreachable"
else
  fail "Studio root returned HTTP $studio - expected 401"
  info "DASHBOARD_USERNAME / DASHBOARD_PASSWORD may be unset in $ENV_FILE."
fi

echo
echo "══ 7. Auth is serving ══"
health=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  -H "apikey: ${ANON_KEY:-}" "${SUPABASE_PUBLIC_URL}/auth/v1/health" 2>/dev/null || echo 000)
if [ "$health" = "200" ]; then
  pass "/auth/v1/health is 200"
else
  fail "/auth/v1/health returned $health"
fi

echo
echo "══ 8. The database is actually local now ══"
# The entire point of the move. ~0.2ms over the compose network against ~125ms
# to Seoul; anything in the tens of milliseconds means traffic is still leaving
# the box.
latency=$(docker exec -i "$DB_CONTAINER" psql -U postgres -d "${POSTGRES_DB:-postgres}" -Atc \
  "\timing on
   SELECT 1;" 2>/dev/null | grep -i '^Time:' | head -1 || true)
if [ -n "$latency" ]; then
  info "in-container SELECT 1 -> $latency"
fi
info "Measure the real number from outside once the API is repointed:"
info "  curl -s -o /dev/null -w '%{http_code} %{time_starttransfer}\\n' https://<app-domain>/v1/health"
info "Expect ~110-115ms rather than ~235ms (DB_LATENCY_MIGRATION.md)."

echo
if [ "$FAILURES" = "0" ]; then
  echo "All checks passed."
else
  echo "$FAILURES check(s) FAILED - see above."
fi
exit "$FAILURES"
