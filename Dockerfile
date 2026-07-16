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

# Own BOTH writable dirs, as a numeric uid/gid, BEFORE VOLUME/USER. When a fresh
# named volume first mounts onto one of these dirs, Docker copies the image
# dir's ownership into the empty volume — so pre-owning them here is what lets
# the non-root runtime user write to /data (relay) and /shim-data (shim).
RUN install -d -o 10001 -g 10001 /data /shim-data

# Relay defaults; the shim service overrides CMD in the compose file.
# SHIM_DATA_DIR is baked to /shim-data so the shim never falls back to the
# default ./primal-shim-data, which resolves under the read-only /app and would
# crash the shim on mkdirSync at startup. HOME=/tmp keeps any stray cache write
# off the read-only rootfs.
ENV WS_HOST=0.0.0.0 STORAGE_PATH=/data \
    SHIM_HOST=0.0.0.0 SHIM_DATA_DIR=/shim-data \
    HOME=/tmp
EXPOSE 3000 8801
VOLUME ["/data"]

# Drop to a non-root numeric user. Numeric (not a name) so the kernel enforces
# it even without a matching /etc/passwd entry, and so no-new-privileges holds.
USER 10001:10001

CMD ["node", "dist/cli.js"]
