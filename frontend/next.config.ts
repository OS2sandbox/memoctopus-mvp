import type { NextConfig } from "next";

import packageJson from "./package.json" with { type: "json" };

const nextConfig: NextConfig = {
  reactCompiler: true,
  output: "standalone",
  env: {
    APP_VERSION: packageJson.version,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "100mb",
    },
  },
};

export default nextConfig;
