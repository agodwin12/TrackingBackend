FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# ──────────────────────────────────────
FROM node:18-alpine AS production

WORKDIR /app

# Copy everything from builder, then prune devDeps
COPY --from=builder /app /app
RUN npm prune --omit=dev

# Create logs dir and set ownership BEFORE switching user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && mkdir -p /app/logs \
    && chown -R appuser:appgroup /app

USER appuser

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5000/health || exit 1

CMD ["node", "server.js"]