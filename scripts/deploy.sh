#!/usr/bin/env bash
# VPS deploy. On every push to main, .github/workflows/deploy.yml runs
# /opt/duevy/deploy.sh, which pulls the code and then runs this script:
#
#   #!/usr/bin/env bash
#   set -euo pipefail
#   cd /opt/duevy/app
#   git fetch --quiet origin main && git reset --hard origin/main
#   exec ./scripts/deploy.sh
#
# (The pull lives there, not here, so this file is never rewritten while it
# runs.) The env file is /opt/duevy/app/.env (git-ignored, never pulled).
#
# Zero-downtime rolling deploy:
#   1. Build the new image once.
#   2. Apply pending migrations once, before any replica runs the new code.
#      The old code keeps serving meanwhile, so a migration must be safe for
#      it (add columns/tables/indexes; drop or rename only in a later deploy,
#      once no running code uses them).
#   3. Replace api_a, wait until it is ready, then api_b. Caddy health-checks
#      both and retries a request on the other replica while one restarts;
#      each replica drains its in-flight requests before it exits.
#   4. Reload Caddy's config without dropping connections.
#
# DEPLOY_DIR and COMPOSE_FILE (Docker's own) let the same script run a local
# rehearsal: see the header of deploy/rehearsal/compose.yml.
set -euo pipefail
cd "${DEPLOY_DIR:-/opt/duevy/app}"

compose() { docker compose "$@"; }

wait_ready() {
  local svc=$1
  for _ in $(seq 1 60); do
    if compose exec -T "$svc" curl -fsS http://localhost:3000/health/ready >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "deploy failed: $svc not ready after 120s" >&2
  compose logs --tail 80 "$svc" >&2
  return 1
}

compose build api_a
compose up -d redis

# Migrations: once, with the new image, while the old replicas still serve.
compose run --rm --no-deps api_a npx prisma migrate deploy

for svc in api_a api_b; do
  compose up -d --no-deps "$svc"
  wait_ready "$svc"
  # Let Caddy's active health check (every 2s) see it, and any passive
  # failure mark on it expire (fail_duration 3s, deploy/caddy/Caddyfile),
  # before the next one goes down, so a replica is always in rotation.
  sleep 5
done

# Caddy: start it if it isn't running (or its mounts changed), else reload
# the config in place.
compose up -d --no-deps caddy
compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile || true

# Remove containers from services that no longer exist (the single `api`
# service before replicas), without touching the ones just rolled.
compose up -d --no-recreate --remove-orphans

echo "deploy ok: $(git rev-parse --short HEAD 2>/dev/null || echo local)"
docker image prune -f >/dev/null
