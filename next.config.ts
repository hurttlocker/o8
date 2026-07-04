import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: __dirname,
  outputFileTracingExcludes: {
    '*': ['./.cortex-worktrees/**/*'],
  },
  serverExternalPackages: ['better-sqlite3'], // Native module — must be bundled explicitly
  reactStrictMode: true,
  devIndicators: false,
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
  turbopack: {},
  webpack: (config, { dev }) => {
    if (dev) {
      return config;
    }

    // Force heavy libraries into separate chunks for parallel loading + caching
    config.optimization = {
      ...config.optimization,
      splitChunks: {
        ...(typeof config.optimization?.splitChunks === 'object' ? config.optimization.splitChunks : {}),
        cacheGroups: {
          ...(typeof config.optimization?.splitChunks === 'object'
            ? (config.optimization.splitChunks as Record<string, unknown>).cacheGroups as Record<string, unknown>
            : {}),
          monaco: {
            test: /[\\/]node_modules[\\/](monaco-editor|@monaco-editor)[\\/]/,
            name: 'vendor-monaco',
            chunks: 'all' as const,
            priority: 30,
          },
          xterm: {
            test: /[\\/]node_modules[\\/]@xterm[\\/]/,
            name: 'vendor-xterm',
            chunks: 'all' as const,
            priority: 30,
          },
          framerMotion: {
            test: /[\\/]node_modules[\\/]framer-motion[\\/]/,
            name: 'vendor-framer',
            chunks: 'all' as const,
            priority: 20,
          },
          mermaid: {
            test: /[\\/]node_modules[\\/]mermaid[\\/]/,
            name: 'vendor-mermaid',
            chunks: 'async' as const,
            priority: 30,
          },
        },
      },
    };

    return config;
  },
  async rewrites() {
    return [
      {
        // [mobile-lan] HTTP-only rewrite to the WS server. Next.js's standalone
        // `server.js` does NOT proxy WebSocket upgrades through rewrites — only
        // plain HTTP. Mobile/desktop WS clients therefore connect directly to
        // ws://<host>:<wsPort>/ws (ws-server binds 0.0.0.0). This rewrite is
        // kept for any future HTTP probe of the ws-server (e.g. /internal/*),
        // but is NOT relied on by the live WS bridge.
        source: '/ws',
        destination: 'http://127.0.0.1:3002/ws',
      },
    ];
  },
};

export default nextConfig;
