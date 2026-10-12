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
# runs.) Rebuilds the api service and recreates its container; Caddy keeps
# running. Pending database migrations run when the container starts (see
# Dockerfile). The env file is /opt/duevy/app/.env (git-ignored, never pulled).
set -euo pipefail
cd /opt/duevy/app

docker compose build api
docker compose up -d api caddy

# Wait for migrations + boot; show logs if the API never comes up.
for _ in $(seq 1 45); do
  if docker compose exec -T api curl -fsS http://localhost:3000/health >/dev/null 2>&1; then
    echo "deploy ok: $(git rev-parse --short HEAD)"
    docker image prune -f >/dev/null
    exit 0
  fi
  sleep 2
done
echo "deploy failed: API not healthy after 90s" >&2
docker compose logs --tail 80 api >&2
exit 1
