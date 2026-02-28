FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate

# --- deps ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/bot/package.json ./apps/bot/
RUN pnpm install --frozen-lockfile --filter bot

# --- build ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/bot/node_modules ./apps/bot/node_modules
COPY apps/bot ./apps/bot
WORKDIR /app/apps/bot
RUN pnpm build

# --- runner ---
FROM node:22-alpine AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 botgroup && \
    adduser  --system --uid  1001 botuser

COPY --from=builder /app/apps/bot/dist ./dist
COPY --from=builder /app/apps/bot/package.json ./

RUN npm install --omit=dev --ignore-scripts

USER botuser
CMD ["node", "dist/index.js"]
