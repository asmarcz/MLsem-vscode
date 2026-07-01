# Build toolchain: node:22-trixie-slim (Debian 13). Tag (not digest) so rebuilds
# pick up security patches automatically; its residual CVEs are unfixable Debian
# perl/ncurses bugs that a `npm ci && tsc` build never invokes and that are
# discarded — none reach the runtime image below.
FROM node:22-trixie-slim AS deps

WORKDIR /app
# `npm ci` installs the exact, integrity-checked versions from the committed
# lockfile (fails if package.json and lock drift) — deterministic, unlike
# `npm install` which can silently resolve newer/substituted versions.
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-trixie-slim AS build

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN npm run build

# Production-only dependencies, with all package install scripts disabled so no
# dependency's lifecycle hook can execute arbitrary code during the build.
FROM node:22-trixie-slim AS prod-deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Distroless runtime: Node + minimal glibc only — no shell, no apt, no npm.
# This is the shipped image (and the one holding the Docker-socket mount), so
# its OS-package attack surface is what matters; debian13 distroless scans 0/0.
FROM gcr.io/distroless/nodejs22-debian13

WORKDIR /app

ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

EXPOSE 8080

# The distroless nodejs image's ENTRYPOINT is `node`, so pass the script only.
CMD ["dist/index.js"]
