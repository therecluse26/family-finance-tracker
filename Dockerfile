# syntax=docker/dockerfile:1

# Node.js 26 on Debian slim, pinned by the digest of its amd64 and arm64 index. Bump both parts
# together.
ARG NODE_IMAGE=node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39

FROM ${NODE_IMAGE} AS base
RUN npm install --global pnpm@12.9.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# better-sqlite3, Sidequest's SQLite driver, compiles from its npm tarball, which the lockfile
# pins. prebuild-install then downloads no binary, and node-gyp uses the image's own Node headers
# instead of fetching them. The final image gets none of these build tools.
FROM base AS native-build
RUN apt-get update \
  && apt-get install --yes --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV npm_config_build_from_source=true
ENV npm_config_nodedir=/usr/local

FROM native-build AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM native-build AS prod-deps
# Of better-sqlite3's build folder, only the compiled module stays. Its objects, its static SQLite
# library, and its test extension are build leftovers. Its deps folder holds the SQLite source it
# compiles from, which nothing reads at run time.
RUN pnpm install --frozen-lockfile --prod \
  && for package in node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3; do \
    build="$package/build" \
    && find "$build" -mindepth 1 ! -path "$build/Release" ! -path "$build/Release/better_sqlite3.node" \
      -delete \
    && test -f "$build/Release/better_sqlite3.node" \
    && rm -r "$package/deps" || exit 1; \
  done

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.source="https://github.com/therecluse26/family-finance-tracker"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"
ENV NODE_ENV=production
WORKDIR /app
COPY package.json LICENSE ./
COPY --from=prod-deps /app/node_modules ./node_modules
# No path under /app is writable by any user but its owner, root.
RUN chmod -R go-w /app/node_modules
# dist holds server.js, fft.js, the web app, and the image's THIRD-PARTY-NOTICES.txt.
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
RUN mkdir /data && chown node:node /data
# The container starts as root. The entrypoint gives /data, /backups, and /run/secrets to UID
# 1000, or to PUID and PGID, then runs the command as that user.
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/fft-entrypoint
# The fft command: `docker compose run --rm app fft <command>`. It goes through the entrypoint, so
# `docker exec`, which skips the entrypoint, still runs it as the app's user and never as root.
RUN printf '#!/bin/sh\nexec fft-entrypoint node /app/dist/fft.js "$@"\n' > /usr/local/bin/fft \
  && chmod 755 /usr/local/bin/fft
EXPOSE 3000
ENTRYPOINT ["fft-entrypoint"]
CMD ["node", "dist/server.js"]
