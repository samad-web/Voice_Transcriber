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
#
# Run it from platform/ on the VPS.

set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE=".env.production"
[[ -f "$ENV_FILE" ]] || { echo "FATAL: $ENV_FILE not found. Run this from platform/ on the VPS."; exit 1; }

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
if [[ "${1:-}" == "--migrate" ]]; then
  shift
  echo "── building images before migrating ──"
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
echo
echo "Deployed."
