#!/usr/bin/env bash
#
# Deploy the production stack, with the right compose overlays, and prove it
# worked before saying it did.
#
# ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
#
# The stack has two edge layouts. Caddy-in-a-container owns :80/:443 on a
# dedicated box; on a box that already runs nginx for another site, Caddy is
# profiled out and every service publishes on a loopback port that the host's
# nginx proxies to. Those loopback ports live in docker-compose.nginx.yml and
# NOWHERE else.
#
# Deploy without that overlay on an nginx box and compose does not complain. It
# recreates the containers without published ports, reports them healthy, and
# every recreated service vanishes behind a 502 - `docker ps` looks perfect
# while the site is down. That is exactly what happened on 2026-08-10, when a
# deploy that only wanted to restart the marketing app took the console and the
# API down with it.
#
# So: the overlay is chosen from what is actually true about the host, and the
# deploy is not called finished until the ports answer.
#
#   ./deploy.sh              # build and restart everything
#   ./deploy.sh --migrate    # run migrations first (needs an image build)
#   ./deploy.sh api worker   # restrict to named services
#   ./deploy.sh --force      # deploy a dirty or out-of-sync tree anyway
#
# Run it from platform/ on the VPS.
#
# ── THE GUARDS, AND THE INCIDENT BEHIND EACH (doc 49 P7-C) ───────────────────
#
# 1. A DIRTY TREE IS REFUSED. On the recorded occasion a parallel session fixed
#    a file between `git add` and `git commit`; the stale copy shipped and
#    crash-looped the production worker (`staged-vs-worktree-deploy-trap`). The
#    image is built from the WORKING TREE, not from the commit, so "what is
#    deployed" is only knowable if the two agree.
#
# 2. A TREE OUT OF SYNC WITH ORIGIN IS REFUSED. Production tracked a feature
#    branch while `main` sat 29 commits behind, which made "what is in
#    production" a question only an SSH session could answer - and that is how
#    drift survives.
#
# 3. MIGRATIONS ARE DETECTED, NOT REMEMBERED. `--migrate` was opt-in, so a
#    deploy carrying a new migration without the flag shipped an image whose
#    queries reference columns that do not exist. 0149 is the recorded case: the
#    API in front of its own missing migration 500s every read on the affected
#    route. This script now compares the tree against `schema_migrations` and
#    refuses rather than hoping somebody passed a flag.
#
# 4. THE RUNNING BUILD IS VERIFIED. "compose exited 0" is not a deploy. The
#    containers must report the BUILD_SHA this script just built, the health
#    path must answer, and max(schema_migrations) must match the tree.

set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE=".env.production"
[[ -f "$ENV_FILE" ]] || { echo "FATAL: $ENV_FILE not found. Run this from platform/ on the VPS."; exit 1; }

die() { echo "FATAL: $*" >&2; exit 1; }

FORCE=0
MIGRATE=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --force)   FORCE=1 ;;
    --migrate) MIGRATE=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- ${ARGS[@]+"${ARGS[@]}"}

# ── 1 & 2. IS THIS TREE WHAT SOMEBODY REVIEWED? ──────────────────────────────
#
# Checked before anything is built, because the only cheap moment to refuse a
# deploy is before it has started.
BUILD_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

if [[ "$BUILD_SHA" == "unknown" ]]; then
  echo "WARNING: not a git checkout - cannot verify what is being deployed."
elif ((FORCE)); then
  echo "WARNING: --force given; skipping the tree checks."
else
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "   uncommitted changes:" >&2
    git status --porcelain | head -10 | sed 's/^/     /' >&2
    die "working tree is dirty. The image is built from the TREE, not the commit, so a
   stale or half-saved file would ship and nothing would say which. Commit or stash
   first, or pass --force if you genuinely mean to deploy an unreviewed tree."
  fi
  if upstream="$(git rev-parse --abbrev-ref '@{u}' 2>/dev/null)"; then
    git fetch --quiet origin "${upstream#origin/}" 2>/dev/null || true
    if [[ "$(git rev-parse HEAD)" != "$(git rev-parse '@{u}')" ]]; then
      ahead="$(git rev-list --count '@{u}..HEAD')"
      behind="$(git rev-list --count 'HEAD..@{u}')"
      die "not in sync with $upstream ($ahead ahead, $behind behind). Push or pull first,
   or pass --force. 'What is in production' has to be answerable from the remote,
   not only from this box."
    fi
  else
    echo "WARNING: $BRANCH has no upstream - cannot verify it matches a remote."
  fi
fi

echo "branch      : $BRANCH"
echo "commit      : $BUILD_SHA"
# Exported so compose interpolates it into api and worker (see
# docker-compose.prod.yml). The worker stamps it on every heartbeat, so "which
# commit is running" stops needing an SSH session.
export BUILD_SHA

# ── Which edge is this host running? ─────────────────────────────────────────
#
# Asked, not assumed. A host process listening on :443 means something other
# than our Caddy container owns the edge, which is precisely the condition the
# nginx overlay exists for. Checking the fact beats a flag someone has to
# remember, because the flag is what gets forgotten at 1am.
FILES=(-f docker-compose.prod.yml)
if ss -tln 2>/dev/null | grep -qE ':443\s' && ! docker ps --format '{{.Names}}' | grep -q 'caddy'; then
  FILES+=(-f docker-compose.nginx.yml)
  EDGE="host nginx (loopback ports published)"
  REQUIRED_PORTS=(18080 18081 18082 18083)
else
  EDGE="caddy container"
  REQUIRED_PORTS=()
fi

echo "edge layout : $EDGE"
echo "compose     : ${FILES[*]}"
echo

compose() { docker compose --env-file "$ENV_FILE" "${FILES[@]}" "$@"; }

# ── Migrations ───────────────────────────────────────────────────────────────
#
# The migrate container runs from the BUILT IMAGE, so a migration added since
# the last build is not in it yet and `migrate` reports "nothing to apply" -
# convincingly, and wrongly. Build first, always.
#
# ── 3. IS A MIGRATION PENDING? ASKED, NOT REMEMBERED ─────────────────────────
#
# The flag used to be the only trigger, so a deploy carrying a new migration
# without `--migrate` shipped an image whose queries name columns the database
# does not have. The failure is not a crash, which would at least be obvious:
# it is a 500 on one route (0149 - every quotation read) while everything else
# looks healthy.
#
# So the tree is compared against the ledger. Read-only, and it never runs a
# migration by itself: it refuses and says what to pass, because running
# migrations is a decision a human should take knowingly.
DB_CONTAINER="${DB_CONTAINER:-aura-supabase-db}"
db_q() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d "${POSTGRES_DB:-postgres}" -Atc "$1" 2>/dev/null
}

TREE_TOP="$(ls packages/db/migrations/*.sql 2>/dev/null | xargs -n1 basename 2>/dev/null | sort | tail -1)"
if [[ -n "$TREE_TOP" ]] && applied_top="$(db_q 'SELECT max(name) FROM schema_migrations')" \
   && [[ -n "$applied_top" ]]; then
  echo "migrations  : tree $TREE_TOP / applied $applied_top"
  if [[ "$TREE_TOP" > "$applied_top" ]]; then
    pending="$(ls packages/db/migrations/*.sql | xargs -n1 basename | sort \
               | awk -v a="$applied_top" '$0 > a' | tr '\n' ' ')"
    if ((MIGRATE)); then
      echo "            pending: $pending"
    else
      die "the tree carries migrations this database does not have:
     $pending
   Re-run with --migrate. Deploying the image first would put code in front of
   its own schema, which 500s one route while everything else reports healthy."
    fi
  elif ((MIGRATE)); then
    echo "            nothing pending; --migrate will be a no-op"
  fi
else
  echo "WARNING: could not read schema_migrations from $DB_CONTAINER - migration state unverified."
  echo "         (Two Supabase stacks run on this box; Aura's is aura-supabase-db. Querying the"
  echo "          bare supabase-db makes production look unmigrated.)"
fi
echo

if ((MIGRATE)); then
  echo "── building images before migrating ──"
  # The migrate container runs from the BUILT IMAGE, so a migration added since
  # the last build is not in it yet and `migrate` reports "nothing to apply" -
  # convincingly, and wrongly. Build first, always.
  compose build api worker
  echo "── applying migrations ──"
  compose --profile setup run --rm migrate
  echo
fi

echo "── build and start ──"
compose up -d --build "$@"

# ── Prove it ─────────────────────────────────────────────────────────────────
#
# Give the containers a moment to bind, then check the ports nginx proxies to.
# Without this the script's success message means "compose exited 0", which is
# the very thing that was misleading in the first place.
if ((${#REQUIRED_PORTS[@]})); then
  sleep 8
  echo
  echo "── checking the loopback ports nginx proxies to ──"
  failed=0
  for port in "${REQUIRED_PORTS[@]}"; do
    if ss -tln | grep -qE "127\.0\.0\.1:$port\s"; then
      printf '  127.0.0.1:%-6s listening\n' "$port"
    else
      printf '  127.0.0.1:%-6s NOT LISTENING\n' "$port"
      failed=1
    fi
  done

  if ((failed)); then
    echo
    echo "FAILED: a port nginx proxies to is not bound. The site is returning 502 right now."
    echo "Most likely the nginx overlay was skipped - re-run:"
    echo "  docker compose --env-file $ENV_FILE -f docker-compose.prod.yml -f docker-compose.nginx.yml up -d"
    exit 1
  fi
fi

echo
compose ps --format 'table {{.Service}}\t{{.Status}}'

# ── 4. VERIFY WHAT IS RUNNING, NOT WHAT WAS ASKED FOR ────────────────────────
#
# Everything above proves compose did as it was told. None of it proves the
# running containers are the code in this tree - which is exactly the gap that
# let a stale image crash-loop production while `docker ps` looked perfect.
echo
echo "── verifying the deploy ──"
verify_failed=0

if [[ "$BUILD_SHA" != "unknown" ]]; then
  for svc in api worker; do
    # Read from the RUNNING container's environment. A container that was not
    # recreated keeps the previous value, which is precisely the case worth
    # catching: a build that succeeded and a container that never restarted.
    running="$(docker exec "$(compose ps -q "$svc" 2>/dev/null | head -1)" \
                 printenv BUILD_SHA 2>/dev/null || echo "")"
    if [[ "$running" == "$BUILD_SHA" ]]; then
      printf '  %-10s running %s\n' "$svc" "${running:0:7}"
    elif [[ -z "$running" ]]; then
      printf '  %-10s NO BUILD_SHA - container not recreated, or compose ran without this script\n' "$svc"
      verify_failed=1
    else
      printf '  %-10s running %s but this tree is %s - STALE\n' "$svc" "${running:0:7}" "${BUILD_SHA:0:7}"
      verify_failed=1
    fi
  done
fi

# The API's own health path, through the port it actually publishes.
health_port=18080
if ((${#REQUIRED_PORTS[@]})); then
  if curl -fsS --max-time 10 "http://127.0.0.1:${health_port}/health" >/dev/null 2>&1; then
    echo "  health     answering on 127.0.0.1:${health_port}"
  else
    echo "  health     NOT answering on 127.0.0.1:${health_port}"
    verify_failed=1
  fi
fi

# And the schema the running code expects.
if applied_top="$(db_q 'SELECT max(name) FROM schema_migrations')" && [[ -n "$applied_top" ]]; then
  if [[ -n "$TREE_TOP" && "$applied_top" == "$TREE_TOP" ]]; then
    echo "  schema     $applied_top (matches the tree)"
  else
    echo "  schema     applied $applied_top, tree $TREE_TOP - MISMATCH"
    verify_failed=1
  fi
fi

# ONE BUSINESS NUMBER, not just liveness. /health was green for the 62 days the
# product transcribed 4% of its calls, so a deploy that reports only "the
# process is up" reports the same thing it reported throughout that outage.
if asr="$(db_q "SELECT coalesce(string_agg(provider || '=' || CASE WHEN parked_until > now() THEN 'PARKED' ELSE 'ok' END, ' '), 'no rows') FROM asr_provider_health")" \
   && [[ -n "$asr" ]]; then
  echo "  asr        $asr"
  [[ "$asr" == *"PARKED"* ]] && echo "             ^ a parked provider transcribes nothing - see scripts/alerts.js"
fi

echo
if ((verify_failed)); then
  echo "DEPLOY FINISHED WITH FAILED CHECKS. The containers are up; they may not be this code."
  echo "Do not walk away from this. Re-run, or check:  docker compose logs --tail 50 api worker"
  exit 1
fi
echo "Deployed and verified: $BRANCH @ ${BUILD_SHA:0:7}"
