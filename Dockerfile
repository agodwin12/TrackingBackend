FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# ──────────────────────────────────────
FROM node:18-alpine AS production

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Africa/Douala

RUN apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/Africa/Douala /etc/localtime \
    && echo "Africa/Douala" > /etc/timezone

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app .

RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && mkdir -p /app/logs \
    && chown -R appuser:appgroup /app

USER appuser

EXPOSE 6000

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:6000/health || exit 1

CMD ["node", "server.js"]