FROM node:22-alpine AS base
# Pinned to match local pnpm + lockfile version (lockfileVersion 9.0).
# pnpm 11 refuses to use a v10-generated lockfile with --frozen-lockfile.
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

# --- deps ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile --filter web --filter @regenhub/shared

# --- build ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
COPY package.json pnpm-workspace.yaml ./
# Build shared package first (node_modules/@regenhub/shared is a symlink to
# packages/shared, so building here makes dist/ available to web automatically)
WORKDIR /app/packages/shared
RUN pnpm build
# Build web
WORKDIR /app/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
RUN pnpm build

# --- runner ---
FROM base AS runner
WORKDIR /app/apps/web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# curl is used by Coolify scheduled tasks to hit the cron endpoints
# from inside the container — alpine base image doesn't include it.
RUN apk add --no-cache curl

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid  1001 nextjs

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static     ./apps/web/.next/static
COPY --from=builder /app/apps/web/public           ./apps/web/public
COPY --from=builder /app/apps/web/cache-handler.cjs ./apps/web/cache-handler.cjs

# The SQL migrations ship with the app so the MCP's run_migration tool can apply
# them (lib/migrations.ts). Lands at /app/apps/web/supabase/migrations — the
# standalone server.js chdir()s into the double-nested /app/apps/web/apps/web,
# so resolveMigrationsDir() tries both cwd/supabase/migrations and
# cwd/../../supabase/migrations and finds it either way. MIGRATIONS_DIR overrides.
COPY supabase/migrations ./supabase/migrations

# Code, static assets, migrations and every parent directory remain root-owned.
# Only data storage is owned by the runtime UID; do not chown .next/server.
ENV ISR_CACHE_DIR=/var/cache/regenhub-isr
RUN chmod -R go-w /app && \
    mkdir -p /var/cache/regenhub-isr apps/web/.next/cache && \
    chown 1001:1001 /var/cache/regenhub-isr apps/web/.next/cache

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "apps/web/server.js"]
