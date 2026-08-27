import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // onnxruntime-web must not be bundled server-side — it loads WASM at runtime
  // and cannot run in Node.js via Next.js SSR. @ricky0123/vad-web is browser-only.
  serverExternalPackages: ['pg', 'onnxruntime-web', '@ricky0123/vad-web'],
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    }
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    // onnxruntime-web uses dynamic require() internally for its WASM/backend
    // loader — webpack can't statically analyze it, producing noisy "Critical
    // dependency" warnings. The package loads WASM at runtime via fetch, so
    // there is nothing for webpack to bundle; suppress the warnings.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { module: /onnxruntime-web/ },
    ];
    return config;
  },
};

export default nextConfig;
