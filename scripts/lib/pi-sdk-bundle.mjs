// Bundles the Pi SDK worker into one file so the packaged server can run it on
// the user's Node without shipping the Pi packages' node_modules (#3255). The
// desktop export and the packaged-layout test both call this, so the test runs
// the same build the app ships.
import { buildSync } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Some Pi dependencies are CommonJS and call require(); ESM output has none.
const REQUIRE_BANNER = "import { createRequire as __o8PiCreateRequire } from 'node:module'; const require = __o8PiCreateRequire(import.meta.url);";

export function bundlePiSdk({ root, outDir }) {
  mkdirSync(outDir, { recursive: true });
  const worker = join(outDir, 'worker.mjs');
  buildSync({
    entryPoints: [join(root, 'scripts', 'pi-sdk', 'worker.mjs')],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Minified to keep the update archive under its ceiling (footprint budget v3).
    minify: true,
    banner: { js: REQUIRE_BANNER },
    absWorkingDir: root,
    logLevel: 'warning',
  });
  // The write helper imports Node built-ins only, so it ships as is.
  const approvedWrite = join(outDir, 'approved-write.mjs');
  copyFileSync(join(root, 'scripts', 'pi-sdk', 'approved-write.mjs'), approvedWrite);
  return { worker, approvedWrite };
}
