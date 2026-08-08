import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@aura/ui"],
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
