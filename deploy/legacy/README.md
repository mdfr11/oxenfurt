# Legacy deploy artefacts

Kept for reference. **Not** the recommended deployment path for Oxenfurt —
see `deploy/README.md` one level up.

## `docker/`

A full-stack `docker-compose.yml` with `postgres` + `oxenfurt-backend` +
`oxenfurt-mini-app` (nginx) containers. The corresponding Dockerfiles and
nginx config live next to it. This was the direction explored early on, then
shelved because:

- The VPS already runs **hermes-english** as a native systemd service. Mixing
  Docker for half the stack and systemd for the other half doubles the
  mental model (two ways to view logs, restart, dump state).
- Single-user / single-VPS Oxenfurt does not need container isolation. The
  systemd hardening directives (`PrivateTmp`, `ProtectSystem`, etc.) give
  most of what Docker would, with one less moving part.
- Hermes → Oxenfurt ingest becomes a trivial loopback HTTP call when both
  run on the same host without a Docker network in between.

If you ever want to revive this path — for example to run a second copy of
Oxenfurt for a different user, or to move to a managed Kubernetes — the
files here are intact starting points. Restore them with:

```sh
mv deploy/legacy/docker/docker-compose.yml ./
mv deploy/legacy/docker/backend.Dockerfile apps/backend/Dockerfile
mv deploy/legacy/docker/mini-app.Dockerfile apps/mini-app/Dockerfile
mv deploy/legacy/docker/mini-app-nginx.conf apps/mini-app/nginx.conf
```

You will need to re-add the `mini-app` and `backend` service blocks to
`docker-compose.yml` (only the `postgres` block remained in the active
file, used for local dev).

## `oxenfurt-backend.service`

An earlier draft of the backend systemd unit that referenced a different
directory layout (`/opt/oxenfurt/backend` instead of the current
`/opt/oxenfurt/current/apps/backend`). Superseded by
`deploy/systemd/oxenfurt-backend.service`. Kept here only because the user
may have already installed it manually before the layout was finalised.
