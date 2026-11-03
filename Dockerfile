# syntax=docker/dockerfile:1

FROM node:26-slim AS base
RUN npm install --global pnpm@12.9.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json LICENSE ./
COPY --from=prod-deps /app/node_modules ./node_modules
# dist holds server.js, the web app, and the image's THIRD-PARTY-NOTICES.txt.
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
