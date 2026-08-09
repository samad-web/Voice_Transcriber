# syntax=docker/dockerfile:1
#
# The public marketing site (apps/marketing). Uses `output: "standalone"`, so the
# runtime image carries a traced subset of node_modules rather than the whole
# workspace.
#
#   docker build -f docker/marketing.Dockerfile -t aura-marketing .   # context = platform/
#
# ── THIS IS NOT THE CONSOLE IMAGE ──────────────────────────────────────────
#
# aura-web serves aura.sirahagents.com: authenticated, holds ADMIN_API_KEY, talks
# to the API. This one serves the public apex and is the opposite in every way —
# unauthenticated, internet-facing, and it holds a database credential.
#
# That credential (FUNNEL_DATABASE_URL) is the whole reason to keep the two
# images and two containers apart. It connects as `aura_marketing`, a role with
# USAGE on the `marketing` schema and nothing else: no access to `public`,
# NOBYPASSRLS, no DELETE anywhere. A compromise of this container yields the
# enquiry tables and no customer's call data. Running the marketing site inside
# the console container would put that credential next to the root admin key and
# throw the separation away.
#
# ── NEXT_PUBLIC_* IS BAKED AT BUILD TIME ───────────────────────────────────
#
# NEXT_PUBLIC_SITE_URL is inlined during `pnpm build`, so the image is tied to
# one origin. It feeds canonical URLs, Open Graph tags and sitemap.xml — get it
# wrong and the sitemap advertises localhost to Google, which is exactly what a
# local build produces. Rebuild, do not just restart, when the domain changes.

FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json        apps/api/
COPY apps/worker/package.json     apps/worker/
COPY apps/web/package.json        apps/web/
COPY apps/marketing/package.json  apps/marketing/
COPY packages/db/package.json     packages/db/
COPY packages/llm/package.json    packages/llm/
COPY packages/queue/package.json  packages/queue/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json     packages/ui/
RUN pnpm install --frozen-lockfile

COPY . .

ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
# Optional. Absent, the WhatsApp call-to-action is simply not rendered — the
# component checks for it rather than emitting a broken wa.me link.
ARG NEXT_PUBLIC_WHATSAPP_NUMBER
ENV NEXT_PUBLIC_WHATSAPP_NUMBER=$NEXT_PUBLIC_WHATSAPP_NUMBER
# Meta Pixel id. Absent means no pixel and no Lead event.
ARG NEXT_PUBLIC_META_PIXEL_ID
ENV NEXT_PUBLIC_META_PIXEL_ID=$NEXT_PUBLIC_META_PIXEL_ID
# Google Tag Manager container, GTM-XXXXXXX. Absent means no container loads.
# All three of these are read at BUILD time by Next and inlined into the
# client bundle, so setting them on the running container does nothing at
# all — a changed id needs a rebuild, not a restart.
ARG NEXT_PUBLIC_GTM_ID
ENV NEXT_PUBLIC_GTM_ID=$NEXT_PUBLIC_GTM_ID
# Microsoft Clarity project id. Absent means no session recording loads.
ARG NEXT_PUBLIC_CLARITY_PROJECT_ID
ENV NEXT_PUBLIC_CLARITY_PROJECT_ID=$NEXT_PUBLIC_CLARITY_PROJECT_ID
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter "@aura/marketing..." build


FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0

# outputFileTracingRoot is the monorepo root, so standalone mirrors the workspace
# layout: server.js lands at apps/marketing/server.js.
COPY --from=builder /app/apps/marketing/.next/standalone ./
COPY --from=builder /app/apps/marketing/.next/static      ./apps/marketing/.next/static
# The marketing site DOES ship static assets (the hero card animation frames, the
# logo, the OG image) and `standalone` does not trace `public/`. Omitting this
# COPY produces a site that renders with every image broken — and it builds and
# starts perfectly, so nothing catches it before a human looks at the page.
COPY --from=builder /app/apps/marketing/public            ./apps/marketing/public

RUN addgroup -g 10001 aura && adduser -u 10001 -G aura -s /bin/sh -D aura \
 && chown -R aura:aura /app
USER aura

EXPOSE 3000
CMD ["node", "apps/marketing/server.js"]
