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
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
