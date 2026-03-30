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
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          '**/node_modules/**',
          '**/.next/**',
          '**/tmp/**',
          '**/*.tsbuildinfo',
          '**/*.log',
          '**/*.png',
          '**/artifacts/**',
          '**/.playwright-mcp/**',
          '**/src-tauri/**',
          '**/.cortex-worktrees/**',
          '**/.claude/worktrees/**',
        ],
      };
    }

    // Force heavy libraries into separate chunks for parallel loading + caching
    if (!dev) {
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
    }

    return config;
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
