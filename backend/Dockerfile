# Production Dockerfile for pg-router-ai Backend & PG Wire TCP Proxy
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json* ./

# Install all dependencies including devDependencies for TypeScript compilation
RUN npm ci || npm install

# Copy backend source code
COPY . .

# Build TypeScript to dist/
RUN npm run build

# --- Production Runner Stage ---
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV PG_PROXY_PORT=5433

COPY package.json package-lock.json* ./

# Install production dependencies only
RUN npm ci --only=production || npm install --only=production

# Copy compiled JavaScript output from builder
COPY --from=builder /app/dist ./dist

# Create data & captures directories
RUN mkdir -p /app/data /app/captures

# Expose HTTP REST / WebSocket port and PG Wire TCP Proxy port
EXPOSE 3000
EXPOSE 5433

CMD ["node", "dist/server.js"]
