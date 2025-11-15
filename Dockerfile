# Multi-stage build for optimized production image
FROM node:20-slim AS builder

# Install build dependencies
RUN apt-get update && \
    apt-get install -y python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files (lockfile optional)
COPY package*.json ./
# Ensure dev dependencies install even if platform injects production flags
ARG NODE_ENV
ENV NODE_ENV=development
ENV npm_config_production=false
ENV NPM_CONFIG_LEGACY_PEER_DEPS=true

# Install dependencies (including dev dependencies for building)
# Fallback to npm install if npm ci fails (e.g., peer deps resolution differences)
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Production stage
FROM node:20-slim

# Install ffmpeg, fonts, and curl for healthcheck
RUN apt-get update && \
    apt-get install -y \
    ffmpeg \
    fonts-noto-cjk \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create app user for security (non-root)
RUN groupadd -r appuser && useradd -r -g appuser appuser

WORKDIR /app

# Install production dependencies (lockfile optional)
COPY package*.json ./
ENV NODE_ENV=production
# Prefer ci, but fall back if lockfile is missing or incompatible
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# Copy built application
COPY --from=builder /app/dist ./dist

# Create necessary directories with proper permissions
RUN mkdir -p uploads temp && \
    chown -R appuser:appuser /app

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

# Start the application
CMD ["node", "dist/index.js"]
