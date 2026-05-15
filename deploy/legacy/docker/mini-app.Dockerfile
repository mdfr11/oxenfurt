FROM oven/bun:1.3.11-alpine AS build

ARG VITE_API_URL=""

WORKDIR /app

RUN apk add --no-cache nodejs npm \
 && npm install -g pnpm@10.8.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/mini-app/package.json apps/mini-app/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile --filter=@oxenfurt/mini-app... --prod=false

COPY apps/mini-app apps/mini-app
COPY packages/shared packages/shared

RUN VITE_API_URL="${VITE_API_URL}" pnpm --filter=@oxenfurt/mini-app build


FROM nginx:1.27-alpine AS runner

# Vite emits static files under /dist; nginx serves them.
COPY --from=build /app/apps/mini-app/dist /usr/share/nginx/html
COPY apps/mini-app/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/ -O /dev/null || exit 1
