import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [
      '.next/**',
      '**/.next/**',
      '.cortex-worktrees/**',
      'node_modules/**',
      '**/node_modules/**',
      '**/.cortex-worktrees/**',
      'out/**',
      'build/**',
      'coverage/**',
      'electron/**',
      'src-tauri/target/**',
      'test-results/**',
      'tmp/**',
      'next-env.d.ts',
    ],
  },
];

export default config;
