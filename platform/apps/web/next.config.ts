import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@aura/ui"],
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Ships a self-contained server bundle with only the traced dependencies —
  // what docker/web.Dockerfile copies into the runtime image.
  output: "standalone",
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
