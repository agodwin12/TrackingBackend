FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# ──────────────────────────────────────
FROM node:18-alpine AS production

WORKDIR /app

# Only copy package files and install prod deps fresh (cleaner than pruning)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source (not node_modules) from builder
COPY --from=builder /app .

# Create logs dir and set ownership BEFORE switching user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && mkdir -p /app/logs \
    && chown -R appuser:appgroup /app

USER appuser

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:5000/health || exit 1

CMD ["node", "server.js"]