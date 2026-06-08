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
    return config;
  },
};

export default nextConfig;
