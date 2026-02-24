
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package
COPY package*.json ./

# Install all dependencies
RUN npm ci

# Copy source code
COPY . .


FROM node:18-alpine AS production

WORKDIR /app


COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app .


RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser


EXPOSE 5000


HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start the app
CMD ["node", "server.js"]