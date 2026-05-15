#!/usr/bin/env bash
# deploy.sh — Build mini-app locally, rsync code + dist to VPS, run
# migrations, swap symlink, restart backend.
#
# Usage:
#   ./deploy.sh                         full deploy (default)
#   ./deploy.sh --skip-build            don't rebuild mini-app (e.g. backend-only)
#   ./deploy.sh --skip-migrate          skip db:migrate (when no schema change)
#   ./deploy.sh --rollback              switch /opt/oxenfurt/current to previous release
#
# Required env (export, or edit the defaults below):
#   OXENFURT_VPS         user@host       (e.g. oxenfurt@vps.example.com)
#   OXENFURT_DOMAIN      domain only     (e.g. oxenfurt.example.com)
#   OXENFURT_SSH_PORT    ssh port        (default 22)

set -euo pipefail

# --- Config ---
VPS="${OXENFURT_VPS:-root@your-vps-host}"
DOMAIN="${OXENFURT_DOMAIN:-oxenfurt.example.com}"
SSH_PORT="${OXENFURT_SSH_PORT:-22}"
REMOTE_BASE="/opt/oxenfurt"

# --- Flags ---
SKIP_BUILD=false
SKIP_MIGRATE=false
ROLLBACK=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)   SKIP_BUILD=true;   shift ;;
    --skip-migrate) SKIP_MIGRATE=true; shift ;;
    --rollback)     ROLLBACK=true;     shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

SSH="ssh -p ${SSH_PORT} ${VPS}"

# --- Rollback path ---
if $ROLLBACK; then
  echo "==> Rollback: switching /opt/oxenfurt/current to previous release"
  $SSH bash -s <<'EOF'
    set -euo pipefail
    cd /opt/oxenfurt/releases
    current=$(readlink /opt/oxenfurt/current | xargs basename)
    previous=$(ls -1 | sort -r | grep -v "^${current}$" | head -1 || true)
    if [ -z "$previous" ]; then
      echo "no previous release available" >&2
      exit 1
    fi
    ln -sfn "/opt/oxenfurt/releases/${previous}" /opt/oxenfurt/current
    systemctl restart oxenfurt-backend
    echo "rolled back to ${previous}"
EOF
  exit 0
fi

# --- Sanity ---
if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync required" >&2; exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm required" >&2; exit 1
fi

cd "$(dirname "$0")/.."   # repo root

RELEASE="$(date -u +%Y%m%d-%H%M%S)"
REMOTE_DIR="${REMOTE_BASE}/releases/${RELEASE}"
echo "==> Release ${RELEASE} → ${VPS}:${REMOTE_DIR}"

# --- 1. Build mini-app on the dev machine ---
if ! $SKIP_BUILD; then
  echo "==> Building mini-app (VITE_API_URL='', same-origin)"
  VITE_API_URL='' pnpm -F @oxenfurt/mini-app build
else
  echo "==> Skipping mini-app build (--skip-build)"
fi

# --- 2. rsync code (backend + shared + workspace metadata) ---
echo "==> rsync backend + shared → release dir"
$SSH "install -d -o oxenfurt -g oxenfurt -m 0755 ${REMOTE_DIR}"
rsync -az --delete \
  -e "ssh -p ${SSH_PORT}" \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='*.tsbuildinfo' \
  apps/backend packages/shared deploy \
  package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json \
  "${VPS}:${REMOTE_DIR}/"

# --- 3. rsync mini-app dist (replaces /opt/oxenfurt/mini-app atomically) ---
if [ -d apps/mini-app/dist ]; then
  echo "==> rsync mini-app dist → /opt/oxenfurt/mini-app"
  rsync -az --delete \
    -e "ssh -p ${SSH_PORT}" \
    apps/mini-app/dist/ \
    "${VPS}:${REMOTE_BASE}/mini-app/"
else
  echo "!! apps/mini-app/dist not found; mini-app static stays untouched"
fi

# --- 4. install deps + migrate + swap symlink + restart ---
echo "==> install deps + migrate + swap"
$SSH bash -s <<EOF
  set -euo pipefail
  cd "${REMOTE_DIR}"
  chown -R oxenfurt:oxenfurt .

  sudo -u oxenfurt pnpm install --frozen-lockfile --filter=@oxenfurt/backend... --prod
  $( $SKIP_MIGRATE && echo "echo '==> Skipping migrations (--skip-migrate)'" || cat <<-MIGRATE
    echo "==> Running migrations"
    set -a; . /etc/oxenfurt/backend.env; set +a
    sudo -u oxenfurt -E /usr/local/bin/bun "${REMOTE_DIR}/apps/backend/src/db/migrate.ts"
MIGRATE
)

  ln -sfn "${REMOTE_DIR}" "${REMOTE_BASE}/current"
  systemctl restart oxenfurt-backend
  systemctl status oxenfurt-backend --no-pager -l | head -12

  # Prune releases beyond the last 5 so disk doesn't fill up.
  cd "${REMOTE_BASE}/releases"
  ls -1tr | head -n -5 | xargs -r rm -rf
EOF

# --- 5. Health check ---
sleep 2
echo "==> Health check"
HTTP=$(curl -fsS -o /dev/null -w "%{http_code}" "https://${DOMAIN}/api/health" || true)
if [ "$HTTP" = "200" ]; then
  echo "==> ✓ /api/health → 200"
else
  echo "==> ✗ /api/health → ${HTTP} (check logs: ssh ${VPS} 'journalctl -u oxenfurt-backend -n 50')"
  exit 1
fi

echo "==> Deploy complete"
