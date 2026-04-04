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
      'dist/**',
      'coverage/**',
      'electron/**',
      'src-tauri/target/**',
      'test-results/**',
      'tmp/**',
      'next-env.d.ts',
    ],
  },
  {
    files: ['src/app/api/**/*.ts', 'src/lib/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];

export default config;
