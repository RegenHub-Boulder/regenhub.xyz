FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# --- deps ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/bot/package.json ./apps/bot/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile --filter bot --filter @regenhub/shared

# --- build ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/bot/node_modules ./apps/bot/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY packages/shared ./packages/shared
COPY apps/bot ./apps/bot
# Build shared package first, then bot
WORKDIR /app/packages/shared
RUN pnpm build
WORKDIR /app/apps/bot
RUN pnpm build

# --- runner ---
FROM node:22-alpine AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 botgroup && \
    adduser  --system --uid  1001 botuser

COPY --from=builder /app/apps/bot/dist ./dist
COPY --from=builder /app/apps/bot/package.json ./

# Install runtime deps first (strip workspace:* dep that npm can't resolve)
RUN sed -i '/"@regenhub\/shared"/d' package.json && \
    npm install --omit=dev --ignore-scripts

# Add shared package AFTER npm install (npm prunes unknown packages)
COPY --from=builder /app/packages/shared/dist ./node_modules/@regenhub/shared/dist
COPY --from=builder /app/packages/shared/package.json ./node_modules/@regenhub/shared/package.json

USER botuser
EXPOSE 3000
CMD ["node", "dist/index.js"]
