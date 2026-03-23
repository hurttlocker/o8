import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: __dirname,
  serverExternalPackages: ['better-sqlite3'], // Native module — must be bundled explicitly
  reactStrictMode: true,
  images: {
    unoptimized: true, // Required for standalone — no image optimization server
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
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-src http://localhost:* http://127.0.0.1:* 'self'; frame-ancestors 'self'",
          },
        ],
      },
    ];
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
