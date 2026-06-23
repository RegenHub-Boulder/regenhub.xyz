FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

# --- deps ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/mcp/package.json ./apps/mcp/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile --filter mcp --filter @regenhub/shared

# --- build ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/mcp/node_modules ./apps/mcp/node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY packages/shared ./packages/shared
COPY apps/mcp ./apps/mcp
# Build shared first, then mcp
WORKDIR /app/packages/shared
RUN pnpm build
WORKDIR /app/apps/mcp
RUN pnpm build

# --- runner ---
FROM node:22-alpine AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 mcpgroup && \
    adduser  --system --uid  1001 mcpuser

COPY --from=builder /app/apps/mcp/dist ./dist
COPY --from=builder /app/apps/mcp/package.json ./

# Runtime deps (strip the workspace:* dep npm can't resolve, then re-add shared after).
RUN sed -i '/"@regenhub\/shared"/d' package.json && \
    npm install --omit=dev --ignore-scripts

COPY --from=builder /app/packages/shared/dist ./node_modules/@regenhub/shared/dist
COPY --from=builder /app/packages/shared/package.json ./node_modules/@regenhub/shared/package.json

USER mcpuser
EXPOSE 3000
CMD ["node", "dist/index.js"]
