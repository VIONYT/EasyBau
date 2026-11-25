# syntax=docker/dockerfile:1.7
# Builds the PWA and serves it from Caddy, which is also the TLS reverse proxy.

FROM node:26-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
ENV NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca
WORKDIR /repo
# Node 25+ no longer ships corepack: install exactly the pnpm of "packageManager" with npm.
COPY package.json ./
RUN --mount=type=secret,id=extra_ca \
    npm install --global --no-fund --no-audit "$(node -p "require('./package.json').packageManager")"
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/schemas/package.json packages/schemas/
COPY packages/domain/package.json packages/domain/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=secret,id=extra_ca --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter=@easybau/web...
COPY apps/web apps/web
COPY packages/schemas packages/schemas
COPY packages/domain packages/domain
COPY packages/ui packages/ui
COPY tsconfig.base.json ./
RUN --mount=type=secret,id=extra_ca pnpm --filter=@easybau/web build

FROM caddy:2-alpine AS runtime
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
