import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
await mkdir('dist', { recursive: true });
await build({ entryPoints: ['native-bench.tsx'], outfile: 'dist/native.mjs', bundle: true, platform: 'node',
  format: 'esm', packages: 'external', jsx: 'automatic', jsxImportSource: '@gpuix/react', sourcemap: true });
await build({ entryPoints: ['preview.tsx'], outfile: 'dist/preview.js', bundle: true, platform: 'browser',
  format: 'esm', jsx: 'automatic', sourcemap: true, define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "production" } };' },
  alias: { '@': resolve(root, '../../src'), react: resolve(root, 'node_modules/react'),
    'react-dom': resolve(root, 'node_modules/react-dom') } });
await copyFile('index.html', 'dist/index.html');
await build({ entryPoints: ['fixture.ts'], outfile: 'dist/fixture.mjs', bundle: true, platform: 'node', format: 'esm' });
const { fixture } = await import('./dist/fixture.mjs');
const { writeFile } = await import('node:fs/promises');
await writeFile('dist/fixture.json', JSON.stringify(fixture));
