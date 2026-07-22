# syntax=docker/dockerfile:1
#
# One image for every Node service in the monorepo — the API, the worker, and
# the one-shot migrate job. They share ~all of their dependency tree, so
# building it once and varying only the command is cheaper than three images.
#
#   docker build -f docker/node.Dockerfile -t aura-node .     # context = platform/
#
# The web app is deliberately NOT here: Next.js has a standalone output that
# produces a much smaller runtime image (see docker/web.Dockerfile).

FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app

# Manifests first so a source-only change reuses the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json      apps/api/
COPY apps/worker/package.json   apps/worker/
COPY apps/web/package.json      apps/web/
COPY packages/db/package.json   packages/db/
COPY packages/llm/package.json  packages/llm/
COPY packages/queue/package.json packages/queue/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json   packages/ui/
RUN pnpm install --frozen-lockfile

COPY . .
# Workspace build order is resolved by pnpm from the dependency graph, so the
# shared packages compile before the apps that import their dist output.
RUN pnpm --filter "@aura/api..." --filter "@aura/worker..." build


FROM node:22-alpine AS runtime
RUN corepack enable && apk add --no-cache curl
WORKDIR /app
ENV NODE_ENV=production

# Install again, this time production-only and filtered to the two services
# that actually run here — that drops the Nest CLI, TypeScript, the type
# packages and the entire Next.js tree the builder needed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json      apps/api/
COPY apps/worker/package.json   apps/worker/
COPY apps/web/package.json      apps/web/
COPY packages/db/package.json   packages/db/
COPY packages/llm/package.json  packages/llm/
COPY packages/queue/package.json packages/queue/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json   packages/ui/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
      --filter "@aura/api..." --filter "@aura/worker..." \
 && pnpm store prune

# Compiled output only. The @aura/* imports resolve through the workspace
# symlinks pnpm just created, so each package needs its dist beside its
# package.json.
COPY --from=builder /app/apps/api/dist        apps/api/dist
COPY --from=builder /app/apps/worker/dist     apps/worker/dist
COPY --from=builder /app/packages/db/dist     packages/db/dist
COPY --from=builder /app/packages/llm/dist    packages/llm/dist
COPY --from=builder /app/packages/queue/dist  packages/queue/dist
COPY --from=builder /app/packages/shared/dist packages/shared/dist
# The migrate job runs these directly — plain CJS, not compiled.
COPY --from=builder /app/packages/db/migrate.js        packages/db/migrate.js
COPY --from=builder /app/packages/db/bootstrap-role.js packages/db/bootstrap-role.js
COPY --from=builder /app/packages/db/verify-rls.js     packages/db/verify-rls.js
COPY --from=builder /app/packages/db/seed.js           packages/db/seed.js
COPY --from=builder /app/packages/db/ssl.js            packages/db/ssl.js
COPY --from=builder /app/packages/db/migrations        packages/db/migrations

# Never run as root; the containers only ever read their own bundle.
RUN addgroup -g 10001 aura && adduser -u 10001 -G aura -s /bin/sh -D aura \
 && chown -R aura:aura /app
USER aura

# Overridden per service in docker-compose.prod.yml.
CMD ["node", "apps/api/dist/main.js"]
