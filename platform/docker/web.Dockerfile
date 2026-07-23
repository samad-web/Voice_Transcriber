# syntax=docker/dockerfile:1
#
# Next.js console. Uses `output: "standalone"`, so the runtime image carries a
# traced subset of node_modules instead of the whole workspace.
#
#   docker build -f docker/web.Dockerfile -t aura-web .       # context = platform/
#
# NEXT_PUBLIC_* values are inlined at BUILD time — the image is therefore tied
# to one domain. Rebuild (don't just restart) when the public URL changes.

FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app

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

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# Supabase Auth. Both are public values (the anon key is safe in the browser),
# but like every NEXT_PUBLIC_* they are baked in here — omit them and the image
# ships with sign-in disabled, no matter what the runtime env says.
ARG NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter "@aura/web..." build


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0

# outputFileTracingRoot is the monorepo root, so standalone mirrors the
# workspace layout: server.js lands at apps/web/server.js.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static      ./apps/web/.next/static
# (no apps/web/public — the console ships no static assets today; add a COPY
#  here if one appears, standalone does not trace that directory.)

RUN addgroup -g 10001 aura && adduser -u 10001 -G aura -s /bin/sh -D aura \
 && chown -R aura:aura /app
USER aura

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
