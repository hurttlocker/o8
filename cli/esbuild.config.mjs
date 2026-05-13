#!/usr/bin/env node
// Bundles cli/src/index.ts into cli/dist/o8.mjs as a single-file ESM Node binary.
// Mirrors the standalone-bundle pattern in scripts/tauri-export.mjs.

import * as esbuild from 'esbuild';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, 'src', 'index.ts');
const outFile = join(__dirname, 'dist', 'o8.mjs');

// esbuild rewrites CJS `require()` calls into a `__require` shim that checks
// `typeof require !== "undefined"`. With pure ESM output, that local `require`
// from createRequire doesn't reach the shim's scope, so any bundled CJS
// module (e.g. `ws` from #1037 mission_tail) throws "Dynamic require of X"
// on first call. Exposing `require` via globalThis lets the shim find it.
const ESM_BANNER = `#!/usr/bin/env node
import { createRequire as __o8_createRequire } from "module";
import { fileURLToPath as __o8_fileURLToPath } from "url";
import { dirname as __o8_dirname } from "path";
const require = __o8_createRequire(import.meta.url);
globalThis.require = require;
const __filename = __o8_fileURLToPath(import.meta.url);
const __dirname = __o8_dirname(__filename);
`;

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: ESM_BANNER },
  outfile: outFile,
});

execSync(`chmod +x ${outFile}`);
console.log(`built ${outFile}`);
