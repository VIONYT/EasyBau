# syntax=docker/dockerfile:1.7
# One image for all roles: APP_ROLE=all|api|worker (ADR 0002).

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Optional extra CA for TLS-inspecting corporate proxies (build secret "extra_ca", may be empty).
ENV NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
RUN --mount=type=secret,id=extra_ca --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN --mount=type=secret,id=extra_ca pnpm turbo run build --filter=@opc/server...
RUN --mount=type=secret,id=extra_ca --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --filter=@opc/server --prod --legacy /out

# Test stage: used by compose.test.yaml and CI (lint, typecheck, unit + integration tests).
FROM deps AS test
ENV NODE_EXTRA_CA_CERTS=
COPY . .
CMD ["sh", "-c", "pnpm lint && pnpm typecheck && pnpm test:coverage"]

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/readyz >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
