#!/usr/bin/env bash
# deploy.sh — Deploy Oxenfurt to VPS
# Run from laptop: ./deploy/deploy.sh
# Or on VPS directly: sudo bash /opt/oxenfurt/deploy.sh

set -euo pipefail

# --- defaults ---
VPS_HOST="${OXENFURT_VPS:-root@localhost}"
VPS_SSH_PORT="${OXENFURT_SSH_PORT:-22}"
DOMAIN="${OXENFURT_DOMAIN:-}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
REL_DIR="/opt/oxenfurt/releases/${TIMESTAMP}"
SKIP_BUILD=false
SKIP_MIGRATE=false
ROLLBACK=false

# --- args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)    SKIP_BUILD=true; shift ;;
    --skip-migrate)  SKIP_MIGRATE=true; shift ;;
    --rollback)      ROLLBACK=true; shift ;;
    *) echo "Unknown: $1" >&2; exit 1 ;;
  esac
done

# --- rollback path ---
if $ROLLBACK; then
  PREVIOUS="$(ls -t /opt/oxenfurt/releases/ | sed -n '2p')"
  if [[ -z "$PREVIOUS" ]]; then echo "No previous release to rollback to" >&2; exit 1; fi
  echo "Rolling back to ${PREVIOUS}..."
  ln -sfn "/opt/oxenfurt/releases/${PREVIOUS}" /opt/oxenfurt/current
  systemctl restart oxenfurt-backend.service
  echo "Done."
  exit 0
fi

# --- build on laptop, rsync to VPS ---
echo "=== Oxenfurt deploy ${TIMESTAMP} ==="

if [[ "$VPS_HOST" != root@localhost ]]; then
  echo "[local] Building mini-app..."
  VITE_API_URL='' pnpm --filter=@oxenfurt/mini-app build 2>&1 | tail -3
fi

echo "[rsync] Sending source to VPS..."
rsync -a \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='.git/' \
  --exclude='*.tsbuildinfo' \
  -e "ssh -p ${VPS_SSH_PORT}" \
  "${SRC_DIR}/" \
  "${VPS_HOST}:${REL_DIR}/"

# --- on VPS ---
ssh -p "${VPS_SSH_PORT}" "${VPS_HOST}" bash -s << VPS_SCRIPT
set -euo pipefail
REL_DIR="${REL_DIR}"
MINI_APP_DIR="/opt/oxenfurt/mini-app"
ENV_FILE="/etc/oxenfurt/backend.env"

echo "[VPS] Installing deps..."
sudo -u oxenfurt env \
  HOME=/opt/oxenfurt \
  TMPDIR=/opt/oxenfurt/.tmp \
  PATH=/usr/bin:/usr/local/bin:/bin \
  pnpm install --frozen-lockfile --dir "\${REL_DIR}" 2>&1 | tail -3

if [[ "${SKIP_BUILD}" != true ]]; then
  echo "[VPS] Building mini-app..."
  sudo -u oxenfurt env \
    HOME=/opt/oxenfurt \
    TMPDIR=/opt/oxenfurt/.tmp \
    PATH=/usr/bin:/usr/local/bin:/bin \
    VITE_API_URL='' \
    pnpm --filter=@oxenfurt/mini-app build --dir "\${REL_DIR}" 2>&1 | tail -3
fi

echo "[VPS] Deploying mini-app static..."
rsync -a --delete "\${REL_DIR}/apps/mini-app/dist/" "\${MINI_APP_DIR}/"
chown -R oxenfurt:oxenfurt "\${MINI_APP_DIR}"

if [[ "${SKIP_MIGRATE}" != true ]]; then
  echo "[VPS] Running migrations..."
  set -a; source "\${ENV_FILE}"; set +a
  sudo -u oxenfurt env \
    HOME=/opt/oxenfurt \
    PATH=/usr/local/bin:/usr/bin:/bin \
    DATABASE_URL="\${DATABASE_URL}" \
    bun "\${REL_DIR}/apps/backend/src/db/migrate.ts" 2>&1 | tail -2
fi

echo "[VPS] Switching symlink..."
ln -sfn "\${REL_DIR}" /opt/oxenfurt/current

# IMPORTANT: Also symlink backend since the service uses /opt/oxenfurt/current
ln -sfn "\${REL_DIR}/apps" /opt/oxenfurt/current/apps 2>/dev/null || true

echo "[VPS] Restarting backend..."
systemctl restart oxenfurt-backend.service
sleep 3

HEALTH=\$(curl -sf "https://\${DOMAIN}/api/health" || echo "FAIL")
echo ""
echo "=== Done ==="
echo "Health: \${HEALTH}"
VPS_SCRIPT

echo "=== deploy.sh finished ==="
