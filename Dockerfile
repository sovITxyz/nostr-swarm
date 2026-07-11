# syntax=docker/dockerfile:1

# --- Build stage: compile the TS ESM sources to dist/ with tsup -------------
FROM node:22-slim AS builder
WORKDIR /app

# Install ALL deps (incl. devDeps like tsup) against the lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# Build inputs only -- keeps the layer cache tight and avoids copying any
# host-side dist/ or data dirs into the image.
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# --- Runtime stage: built dist + the builder's node_modules -----------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The rocksdb-native prebuild (Holepunch storage backend) links libatomic,
# which node:22-slim doesn't ship — without it the addon fails to dlopen.
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 \
    && rm -rf /var/lib/apt/lists/*

# Copy the builder's node_modules wholesale (same approach as start9/Dockerfile).
# The Holepunch stack ships native addons (rocksdb-native, sodium-native) whose
# prebuilt .node binaries are placed during the builder's `npm ci`; a fresh
# `npm ci --omit=dev` or `npm prune` in this stage drops those addons, so the
# relay fails at startup. Keeping the full tree is the proven, correct trade.
COPY package.json package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Relay defaults; the shim service overrides CMD in docker-compose.yml.
ENV WS_HOST=0.0.0.0 \
    STORAGE_PATH=/data
EXPOSE 3000 8801
VOLUME ["/data"]

CMD ["node", "dist/cli.js"]
