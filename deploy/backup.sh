#!/usr/bin/env bash
# backup.sh — Postgres dump + rotation, optionally pushed off-site.
# Run by oxenfurt-backup.service (systemd timer schedules it).

set -euo pipefail

# Where backups land. Owned by oxenfurt:oxenfurt, mode 0750.
BACKUP_DIR=/opt/oxenfurt/backups
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}

mkdir -p "$BACKUP_DIR"
TS=$(date -u +%Y%m%d-%H%M%S)
DUMP="${BACKUP_DIR}/oxenfurt-${TS}.sql.gz"

# Extract host/port/user/db from DATABASE_URL so pg_dump can use peer auth
# locally without echoing the password back to the command line.
# DATABASE_URL=postgres://USER:PASS@HOST:PORT/DB
url="${DATABASE_URL:-}"
if [ -z "$url" ]; then
  echo "DATABASE_URL is not set; cannot back up" >&2
  exit 1
fi
# Strip scheme.
no_scheme="${url#postgres://}"
no_scheme="${no_scheme#postgresql://}"
userpass="${no_scheme%%@*}"
hostpart="${no_scheme#*@}"
PGUSER="${userpass%%:*}"
PGPASSWORD="${userpass#*:}"
hostonly="${hostpart%%/*}"
PGDATABASE="${hostpart#*/}"
PGDATABASE="${PGDATABASE%%\?*}"  # trim optional query string
PGHOST="${hostonly%%:*}"
PGPORT="${hostonly#*:}"
if [ "$PGPORT" = "$hostonly" ]; then PGPORT=5432; fi

export PGUSER PGPASSWORD PGHOST PGPORT PGDATABASE

echo "==> Dumping ${PGDATABASE} from ${PGHOST}:${PGPORT} as ${PGUSER}"
pg_dump --no-owner --no-privileges --format=plain \
  | gzip --best > "${DUMP}.partial"
mv "${DUMP}.partial" "${DUMP}"
echo "==> Wrote $(du -h "${DUMP}" | cut -f1) → ${DUMP}"

# Rotation: delete dumps older than RETENTION_DAYS.
deleted=$(find "$BACKUP_DIR" -name 'oxenfurt-*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete -print | wc -l)
if [ "$deleted" -gt 0 ]; then
  echo "==> Rotated ${deleted} backup(s) older than ${RETENTION_DAYS} days"
fi

# Optional off-site push via rclone.
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  if ! command -v rclone >/dev/null 2>&1; then
    echo "BACKUP_RCLONE_REMOTE is set but rclone is not installed; skipping" >&2
  else
    echo "==> Pushing to ${BACKUP_RCLONE_REMOTE}"
    rclone copy --quiet "${DUMP}" "${BACKUP_RCLONE_REMOTE}/"
  fi
fi

echo "==> Done at $(date -u +%FT%TZ)"
