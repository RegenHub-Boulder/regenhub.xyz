FROM node:22-alpine AS base
# Pinned to match local pnpm + lockfile version.
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

# --- deps ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/mcp/package.json ./apps/mcp/
RUN pnpm install --frozen-lockfile --filter mcp

# --- build ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/mcp/node_modules ./apps/mcp/node_modules
COPY apps/mcp ./apps/mcp
WORKDIR /app/apps/mcp
RUN pnpm build

# --- runner ---
FROM node:22-alpine AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 mcpgroup && \
    adduser  --system --uid  1001 mcpuser

COPY --from=builder /app/apps/mcp/dist ./dist
COPY --from=builder /app/apps/mcp/package.json ./

# Runtime deps only (no workspace deps in Phase 0).
RUN npm install --omit=dev --ignore-scripts

USER mcpuser
EXPOSE 3000
CMD ["node", "dist/index.js"]
