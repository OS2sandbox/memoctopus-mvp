import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: ['localhost:3002'],
    },
  },
  serverExternalPackages: ['pg', 'better-auth'],
};

export default nextConfig;
