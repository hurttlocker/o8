import path from 'node:path';

export const sharedVitestConfig = {
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../../src'),
      'server-only': path.resolve(__dirname, '../../tests/stubs/server-only.ts'),
    },
  },
  test: {
    environment: 'node',
    globalSetup: ['tests/global-test-data-dir.ts'],
    setupFiles: ['tests/setup-isolated-data-dir.ts'],
    include: [
      'src/**/*.test.ts',
      'src/components/desktop/thoughts/composer-selector/ComposerSelectorFooter.test.tsx',
      'src/components/desktop/file-viewer/RichMarkdownEditor.test.tsx',
      'src/components/desktop/settings/SymonIMessageAccessSection.test.tsx',
      'tests/**/*.test.ts',
      'cli/**/*.test.ts',
    ],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
};
