# syntax=docker/dockerfile:1

FROM node:26-slim AS base
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
RUN pnpm install --frozen-lockfile --prod

FROM node:26-slim
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
# The fft command: `docker compose run --rm app fft <command>`.
RUN printf '#!/bin/sh\nexec node /app/dist/fft.js "$@"\n' > /usr/local/bin/fft \
  && chmod 755 /usr/local/bin/fft
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
