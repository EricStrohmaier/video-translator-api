# Multi-stage build for optimized production image
FROM node:20-slim AS builder

# Install build dependencies
RUN apt-get update && \
    apt-get install -y python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including dev dependencies for building if needed)
RUN npm ci

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

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application code
COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src

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
CMD ["npm", "start"]
