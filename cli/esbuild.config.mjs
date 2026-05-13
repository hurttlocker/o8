#!/usr/bin/env node
// Bundles cli/src/index.ts into cli/dist/o8.mjs as a single-file ESM Node binary.
// Mirrors the standalone-bundle pattern in scripts/tauri-export.mjs (esbuild,
// platform=node, format=esm, ESM-shim banner). The shebang lets the file be
// run directly once chmod +x; npm exposes it via the `bin` field as well.

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, 'src', 'index.ts');
const outFile = join(__dirname, 'dist', 'o8.mjs');

const ESM_BANNER = [
  '#!/usr/bin/env node',
  'import { createRequire as __o8_createRequire } from "module";',
  'import { fileURLToPath as __o8_fileURLToPath } from "url";',
  'import { dirname as __o8_dirname } from "path";',
  'const require = __o8_createRequire(import.meta.url);',
  'const __filename = __o8_fileURLToPath(import.meta.url);',
  'const __dirname = __o8_dirname(__filename);',
].join(' ');

const args = [
  'esbuild',
  entry,
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node22',
  `--banner:js='${ESM_BANNER}'`,
  `--outfile=${outFile}`,
];

execSync(`npx ${args.join(' ')}`, {
  cwd: __dirname,
  stdio: 'inherit',
});

// chmod +x so `./dist/o8.mjs` works directly without `node` in front.
execSync(`chmod +x ${outFile}`);

console.log(`built ${outFile}`);
