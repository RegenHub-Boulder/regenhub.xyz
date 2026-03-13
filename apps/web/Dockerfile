FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

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
# Build shared package first
WORKDIR /app/packages/shared
RUN pnpm build
# Copy built shared dist into root node_modules (shamefully-hoist puts it there, and
# Docker COPY dereferences the pnpm workspace symlink so dist/ is missing)
RUN mkdir -p /app/node_modules/@regenhub/shared && \
    cp -r /app/packages/shared/dist /app/node_modules/@regenhub/shared/dist && \
    cp /app/packages/shared/package.json /app/node_modules/@regenhub/shared/package.json
# Build web
WORKDIR /app/apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# --- runner ---
FROM base AS runner
WORKDIR /app/apps/web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid  1001 nextjs

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static     ./apps/web/.next/static
COPY --from=builder /app/apps/web/public           ./apps/web/public

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "apps/web/server.js"]
