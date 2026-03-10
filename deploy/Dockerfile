# =============================================================================
# Claude Kanban — Multi-stage production Dockerfile
# =============================================================================
# Build: docker build -t claude-kanban .
# Run:   docker run -d -p 51777:51777 -v kanban-data:/app/.data --env-file .env claude-kanban
# =============================================================================

# --- Stage 1: Build native modules ---
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++ gcc musl-dev

WORKDIR /build

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy package files first (layer caching)
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including native: better-sqlite3, argon2)
RUN pnpm install --frozen-lockfile

# --- Stage 2: Production image ---
FROM node:22-alpine AS production

# Security: non-root user
RUN addgroup -g 1001 -S kanban && \
    adduser -u 1001 -S kanban -G kanban

WORKDIR /app

# Runtime deps for native modules
RUN apk add --no-cache libstdc++ curl

# Copy built node_modules from builder
COPY --from=builder /build/node_modules ./node_modules

# Copy application source
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY tests/ ./tests/
COPY docs/ ./docs/

# Create data directory (volume mount point)
RUN mkdir -p .data && chown -R kanban:kanban /app

# Switch to non-root
USER kanban

# Expose main server port
EXPOSE 51777

# Health check — shallow liveness every 30s, 3 retries
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:51777/health || exit 1

# Persistent data volume
VOLUME ["/app/.data"]

# Start server
CMD ["node", "src/server.js"]
