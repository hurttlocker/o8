import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
      {
        protocol: 'https',
        hostname: 'github.com',
      },
    ],
  },
  async rewrites() {
    return [
      {
        // Proxy WebSocket upgrade + HTTP requests to the WS server.
        // This lets mobile clients connect via the same host:port as the
        // page (no separate port 3002 needed over Tailscale / remote).
        source: '/ws',
        destination: 'http://127.0.0.1:3002/ws',
      },
    ];
  },
};

export default nextConfig;
