import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const wkWebViewApiGuardMessage = 'Use safeRequestIdleCallback from @/lib/util/webview-safe — requestIdleCallback is undefined in the macOS WKWebView (see directive cortex-ide-wkwebview-api-guard).';

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
    rules: {
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'no-restricted-globals': ['error',
        {
          name: 'requestIdleCallback',
          message: wkWebViewApiGuardMessage,
        },
        {
          name: 'cancelIdleCallback',
          message: wkWebViewApiGuardMessage,
        },
      ],
      'no-restricted-syntax': ['error',
        {
          selector: 'CallExpression[callee.name=/^(requestIdleCallback|cancelIdleCallback)$/]',
          message: wkWebViewApiGuardMessage,
        },
        {
          selector: 'CallExpression[callee.object.name="window"][callee.property.name=/^(requestIdleCallback|cancelIdleCallback)$/]',
          message: wkWebViewApiGuardMessage,
        },
        {
          selector: 'MemberExpression[object.name="window"][property.name=/^(requestIdleCallback|cancelIdleCallback)$/]',
          message: wkWebViewApiGuardMessage,
        },
      ],
    },
  },
  {
    files: ['src/app/api/**/*.ts', 'src/lib/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['src/lib/util/webview-safe.ts'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-syntax': 'off',
    },
  },
];

export default config;
