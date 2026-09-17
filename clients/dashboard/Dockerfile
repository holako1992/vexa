# syntax=docker/dockerfile:1
# Vexa Dashboard (v0.12) — Next.js 15 meetings + transcripts client.
#
# Unlike the terminal, this app has no custom server: it opens no websocket and needs no upgrade
# proxy, so it runs on Next's own `next start`. It still ships the PRUNED PRODUCTION node_modules
# rather than `output: standalone`, for the reason the terminal's Dockerfile gives: a standalone
# trace is not reliably complete, and a module it misses is a crash at container start rather than
# a build error. Pruned prod deps are the shape this repo has proven.
#
# Build context: clients/dashboard (self-contained npm project; no @vexa/* workspace deps).

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# deps: pruned production deps. typescript must ALSO be present — Next loads the TypeScript
# next.config.ts at runtime and npm-installs its own at BOOT when it is absent. `npm i typescript`
# here CANNOT provide it: NODE_ENV=production makes npm silently omit anything matching a
# devDependency. So it is COPIED from the build stage — the exact compiler `next build` ran with.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/node_modules/typescript ./node_modules/typescript

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
# next-env.d.ts is gitignored (Next generates it during `next build`), so it comes from the build
# stage rather than the build context, where a clean clone does not have it.
COPY --from=build /app/next-env.d.ts ./
COPY next.config.ts tsconfig.json ./
# Run as the image's unprivileged user. A web client has no reason to be root, and a container
# escape starts from whatever the process already is. `.next` is read-only at runtime.
RUN chown -R node:node /app
USER node
EXPOSE 3001
# `npm start` === next start --port ${PORT:-3001}
CMD ["npm", "start"]
