import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:3000'],
    },
  },
  serverExternalPackages: ['pg', 'better-auth'],
};

export default nextConfig;
