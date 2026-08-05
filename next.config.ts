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
  // o8's dev flow standardizes on http://127.0.0.1:47120, but Next dev's
  // cross-origin protection only allows `localhost` by default and its
  // REJECTION of the HMR WebSocket upgrade is not valid HTTP — every real
  // browser on the IP origin logged ERR_INVALID_HTTP_RESPONSE, the Turbopack
  // dev client hung in a retry loop, and hydration never completed with zero
  // errors surfaced (#1731). Origin-less probes (curl, bare `ws`) sailed
  // through, which is why the server looked healthy from every non-browser
  // measurement. Prod is unaffected: the check is dev-only.
  allowedDevOrigins: ['127.0.0.1'],
  // No rewrites. A vestigial `/ws → http://127.0.0.1:3002` proxy rewrite
  // (dead port; relayed surfaces use the machine transport and direct clients
  // dial ws://<host>:<wsPort> themselves) was removed during the #1731 hunt —
  // it was NOT the cause, just dead config not worth restoring.
};

export default nextConfig;
