import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@aura/ui"],
  outputFileTracingRoot: path.join(__dirname, "../.."),

  // NOT a static export. Doc 16 §4 is explicit: slice 4 adds server actions for
  // the funnel, and `output: "export"` would make that impossible. Every content
  // page here is still statically rendered at build time (no cookies(), no
  // headers(), no dynamic fetch) - only the funnel routes will opt into dynamic.
  //
  // `standalone` produces the self-contained server bundle a container image
  // copies. Tracing symlinks pnpm's store, which needs a privilege Windows only
  // grants to an admin shell or with Developer Mode on; the image build (Linux)
  // is unaffected. Set NEXT_SKIP_STANDALONE=1 to verify a build locally.
  output: process.env.NEXT_SKIP_STANDALONE === "1" ? undefined : "standalone",

  // Same separation of concerns as apps/web: `next build` compiles, `pnpm lint`
  // lints. A promoted lint rule must not be able to hold the deploy hostage.
  // Typecheck stays a build gate - `tsc` disagreeing with the code is a compile
  // failure, not a style opinion.
  eslint: { ignoreDuringBuilds: true },

  // AVIF first, then WebP - doc 10 §9. Explicit dimensions are the author's job.
  images: {
    formats: ["image/avif", "image/webp"],
  },

  // The marketing site collects nothing, embeds nothing and calls nothing. Say
  // so in headers as well as in copy - a privacy-forward posture that is only
  // asserted in prose is not a posture.
  //
  // ── THE ONE EXCEPTION, AND WHY IT IS NARROW ──────────────────────────────
  //
  // `/f/<slug>` is a tenant's own hosted form (migration 0161, doc 39 §16),
  // and two of its three distribution methods are an `<iframe>` and a
  // `<script>` that injects one. `X-Frame-Options: DENY` makes both of them a
  // blank box in the customer's page with an error in the console, so the
  // catch-all below EXCLUDES that one prefix and the rule after it re-states
  // the other three headers for it with `frame-ancestors *` in place of the
  // framing ban.
  //
  // Framing it from anywhere is the intent, not a concession: the page exists
  // to be put on the tenant's own site, that list is tenant data, it changes
  // without a deployment, and it is not knowable here. The same argument
  // `OPEN_ORIGIN_PATHS` in the API's cors.ts makes in full about the intake
  // endpoint. What stands in for a framing restriction is that the page holds
  // nothing to steal: no session, no cookie, no authenticated read - a
  // clickjack of it submits a lead to the tenant who published it.
  //
  // Written as a negative-lookahead `source` rather than by setting
  // `X-Frame-Options` to some permissive value on the second rule, because
  // that header has no "allow any" form - `ALLOWALL` is non-standard and
  // ignored inconsistently, and an empty value is simply an invalid header.
  // The only way to not send it is to not match the rule that sends it.
  async headers() {
    const base = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
      },
    ];
    return [
      {
        source: "/((?!f/).*)",
        headers: [...base, { key: "X-Frame-Options", value: "DENY" }],
      },
      {
        source: "/f/:path*",
        headers: [...base, { key: "Content-Security-Policy", value: "frame-ancestors *" }],
      },
    ];
  },
};

export default nextConfig;
