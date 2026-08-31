#!/usr/bin/env bash
#
# Create the marketing funnel schema and its scoped role, then rotate that
# role's password off the repository default.
#
#   bash platform/scripts/apply-marketing-schema.sh <path-to-env-file>
#
# e.g.  bash platform/scripts/apply-marketing-schema.sh platform/.env.production
#
# ─────────────────────────────────────────────────────────────────────────────
# WHAT IT DOES TO THE TARGET DATABASE
#
#   CREATE SCHEMA marketing
#   CREATE ROLE   aura_marketing   (NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS)
#   CREATE TABLE  marketing.funnel_submissions, funnel_contact_history, funnel_rate_limit
#   GRANT         USAGE on the schema + SELECT/INSERT/UPDATE on those three tables,
#                 to aura_marketing only
#   REVOKE        everything on the schema from PUBLIC and from Supabase's
#                 anon / authenticated / service_role
#   ALTER TABLE   marketing.funnel_submissions ADD converted_org_id/at/by  (0021)
#   GRANT         column-scoped UPDATE on funnel_contact_history            (0022)
#
# Every statement is additive and confined to the new `marketing` schema. It does
# not read, alter, or drop anything in `public` - no tenant table, no call, no
# recording, no user. The only statements touching pre-existing objects are the
# REVOKEs, and those revoke access TO THE NEW SCHEMA from roles that should never
# have had it.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY THE PASSWORD ROTATION IS NOT OPTIONAL
#
# Migration 0020 creates the role with the literal password
# 'aura_marketing_password' - a development default that is committed to this
# repository and present in its git history. On a production database that is a
# working login for anyone who can read the repo.
#
# So this script rotates it in the SAME psql session, seconds later, to 32 random
# bytes. The new password is written to a file you nominate and printed nowhere.
# Put it in the marketing app's production environment as FUNNEL_DATABASE_URL.
#
# ─────────────────────────────────────────────────────────────────────────────
# ONE THING TO UNDERSTAND BEFORE RUNNING IT AGAINST PRODUCTION
#
# After this, a public and unauthenticated web server holds a credential to the
# database that stores real customer call recordings. The role is walled off -
# no USAGE on `public`, NOBYPASSRLS, no DELETE anywhere - so a compromise of the
# marketing server yields the funnel tables and nothing else. That is a real and
# deliberate reduction of blast radius, not an argument that the risk is zero:
# the marketing host gains a network path and a valid login where it previously
# had neither. If Supabase network restrictions are available on the project,
# pinning them to the marketing host closes most of what remains.
#
set -euo pipefail

ENVF="${1:-}"
if [ -z "$ENVF" ] || [ ! -f "$ENVF" ]; then
  echo "usage: bash $0 <path-to-env-file-containing-DATABASE_URL>" >&2
  exit 64
fi

PSQL="${PSQL:-/c/Program Files/PostgreSQL/18/bin/psql.exe}"
[ -x "$PSQL" ] || { echo "psql not found at: $PSQL   (override with PSQL=...)" >&2; exit 69; }

HERE="$(cd "$(dirname "$0")" && pwd)"
MIG_DIR="$HERE/../packages/db/migrations"
PW_OUT="${PW_OUT:-$HERE/../.marketing-role-password}"

# DATABASE_URL is the migration owner. Read into a variable; never echoed.
URL="$(grep -m1 '^DATABASE_URL=' "$ENVF" | cut -d= -f2- | tr -d '\r')"
[ -n "$URL" ] || { echo "DATABASE_URL not found in $ENVF" >&2; exit 65; }

echo "target: $(printf '%s' "$URL" | sed -E 's#://([^:]+):[^@]+@#://\1:***@#')"
printf 'Type APPLY to proceed: '
read -r CONFIRM
[ "$CONFIRM" = "APPLY" ] || { echo "aborted."; exit 1; }

PW="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"

echo
echo "── pre-flight ─────────────────────────────────────────────"
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -At -c \
  "SELECT coalesce((SELECT 'marketing schema ALREADY EXISTS'
                      FROM information_schema.schemata
                     WHERE schema_name='marketing'), 'marketing schema absent');"

echo
echo "── applying 0020 ──────────────────────────────────────────"
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -f "$MIG_DIR/0020_funnel_submissions.sql"

echo "── applying 0021 ──────────────────────────────────────────"
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -f "$MIG_DIR/0021_funnel_conversion.sql"

echo "── applying 0022 ──────────────────────────────────────────"
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -f "$MIG_DIR/0022_funnel_history_update_grant.sql"

echo "── rotating aura_marketing off the repo default ───────────"
# Piped through -f - rather than -c, and this is not a style choice.
#
# psql does NOT perform variable interpolation on a -c command string, so
# `-v pw=… -c "ALTER ROLE … PASSWORD :'pw'"` sends the literal `:'pw'` to the
# server and fails with a syntax error. That happened on the first production
# run: both migrations applied, then this step died - leaving the role live with
# the repo's committed default password until it was rotated by hand.
#
# Interpolation works for input read from a file or stdin, hence `-f -`. The
# password is base64url (A-Z a-z 0-9 - _), so it contains nothing that needs
# escaping inside single quotes.
printf "ALTER ROLE aura_marketing PASSWORD '%s';\n" "$PW" \
  | "$PSQL" "$URL" -v ON_ERROR_STOP=1 -q -f -

# Write the password BEFORE the verification block. Previously it was written
# after, so a failure anywhere between generating it and the end of the script
# lost the only copy - which is exactly what happened.
umask 077
printf '%s\n' "$PW" > "$PW_OUT"
echo "new password written to: $PW_OUT   (chmod 600, not printed)"

echo "── confirming the repo default no longer authenticates ────"
DEFAULT_URL="$(printf '%s' "$URL" | sed -E 's#://[^:]+:[^@]+@#://aura_marketing:aura_marketing_password@#')"
if "$PSQL" "$DEFAULT_URL" -At -c "SELECT 1;" >/dev/null 2>&1; then
  echo "!! FATAL: the default password STILL WORKS. Rotate it by hand now." >&2
  exit 70
fi
echo "ok - default password rejected"


echo
echo "── verify ─────────────────────────────────────────────────"
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -c \
  "SELECT table_name FROM information_schema.tables
    WHERE table_schema='marketing' ORDER BY 1;"
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -c \
  "SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
     FROM pg_roles WHERE rolname='aura_marketing';"

echo "── containment check (both MUST be false) ─────────────────"
"$PSQL" "$URL" -v ON_ERROR_STOP=1 -c \
  "SELECT has_schema_privilege('aura_marketing','public','USAGE')            AS can_use_public,
          has_table_privilege ('aura_marketing','public.organizations','SELECT') AS can_read_orgs;"

cat <<EOF

── done ───────────────────────────────────────────────────

Next: set FUNNEL_DATABASE_URL in the marketing app's environment. For Supabase
the pooler expects the role name suffixed with the project ref:

  FUNNEL_DATABASE_URL=postgresql://aura_marketing.<project-ref>:<password>@<pooler-host>:5432/postgres

Take <password> from $PW_OUT, then delete that file.
EOF
