FROM oven/bun:1.3.11-alpine AS deps

WORKDIR /app

# Install pnpm (workspace lockfile is pnpm-format).
RUN apk add --no-cache nodejs npm \
 && npm install -g pnpm@10.8.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/backend/package.json apps/backend/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile --filter=@oxenfurt/backend... --prod=false


FROM oven/bun:1.3.11-alpine AS runner

WORKDIR /app

# App sources + node_modules.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/backend/node_modules ./apps/backend/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY apps/backend ./apps/backend
COPY packages/shared ./packages/shared
COPY package.json pnpm-workspace.yaml ./

RUN addgroup -g 1001 -S oxenfurt && adduser -S oxenfurt -u 1001 \
 && chown -R oxenfurt:oxenfurt /app

USER oxenfurt
WORKDIR /app/apps/backend
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["bun", "src/index.ts"]
