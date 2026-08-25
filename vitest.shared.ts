import path from 'node:path';

export const sharedVitestConfig = {
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    globalSetup: ['tests/global-test-data-dir.ts'],
    setupFiles: ['tests/setup-isolated-data-dir.ts'],
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'cli/**/*.test.ts'],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
};
