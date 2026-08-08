import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@aura/ui"],
  /**
   * The console lives under /admin, sharing aura.sirahagents.com with the
   * marketing site (owner's decision, 2026-08-09: the apex points at a
   * different server, and this is the domain we control).
   *
   * `basePath`, NOT an nginx rewrite. Next bakes the prefix into every
   * generated link, every Server Action endpoint and — the part a rewrite
   * cannot fix — the `/_next/static/...` asset URLs. Stripping /admin at the
   * proxy would serve HTML that then asks for its JavaScript at the root, where
   * the marketing site answers with its own 404 page, and the console would
   * render unstyled and inert with no error anywhere.
   *
   * WHAT MUST NOT MOVE: `/v1/*` on this host. Enrolled handsets carry
   * aura.sirahagents.com in their activation payload and POST recordings to it,
   * so nginx routes /v1 to the API ahead of everything else. Changing that
   * bricks every phone in the field, and they cannot be re-pointed remotely.
   *
   * Configurable so local development stays at the root: `pnpm dev` serves the
   * console on :3000 with no prefix, and only the container build sets it.
   */
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Ships a self-contained server bundle with only the traced dependencies —
  // what docker/web.Dockerfile copies into the runtime image.
  //
  // Tracing symlinks pnpm's store, which needs a privilege Windows only grants
  // to an admin shell or with Developer Mode on; the image build (Linux) is
  // unaffected. Set NEXT_SKIP_STANDALONE=1 to verify a build locally.
  output: process.env.NEXT_SKIP_STANDALONE === "1" ? undefined : "standalone",
  // LINT IS NOT A DEPLOY GATE. `next build` runs ESLint by default and treats
  // any *error* as a compile failure, which means the flat config at
  // platform/eslint.config.mjs silently holds the deploy pipeline hostage: when
  // Stage 1 introduced that config it promoted seven pre-existing issues in this
  // app to errors, `pnpm -r build` and CI's `docker build` job both started
  // exiting 1, and the console could not be built at all. Nobody noticed,
  // because a lint config is not where you look for a broken image build.
  //
  // Promoting one rule must never be able to do that again, so the two concerns
  // are separated here: `next build` compiles, `pnpm lint` lints. The lint gate
  // lives in CI's `static` job — see .github/workflows/ci.yml. THAT job is where
  // a new error has to be caught; if you are turning a rule on, run
  // `pnpm --filter @aura/web lint` before you push, because this file guarantees
  // the build will not do it for you.
  //
  // (Typecheck is deliberately still a build gate. `tsc` disagreeing with the
  // code is a compile failure by definition, not a style opinion, and there is
  // no equivalent backlog — `pnpm -r typecheck` is at 8/8 clean.)
  eslint: { ignoreDuringBuilds: true },
  // Fleet & MDM became Instances — devices are now viewed inside their customer,
  // and compliance (policy / erasure / audit) moved onto the instance detail page.
  async redirects() {
    return [
      { source: "/devices", destination: "/instances", permanent: false },
      { source: "/devices/activation", destination: "/instances/new", permanent: false },
      { source: "/compliance", destination: "/instances", permanent: false },
    ];
  },
};

export default nextConfig;
