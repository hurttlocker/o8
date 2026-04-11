#!/usr/bin/env node
/**
 * Tauri prebuild — splits the build into:
 *   out/frontend/  → Tauri frontendDist (just the loader HTML)
 *   out/server/    → Tauri bundle resource (Next.js server + Node binary)
 */
import { cpSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const out = join(root, 'out');
const frontend = join(out, 'frontend');
const server = join(out, 'server');
const standalone = join(root, '.next', 'standalone');
const staticDir = join(root, '.next', 'static');
const pub = join(root, 'public');

// Clean previous build
if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(frontend, { recursive: true });
mkdirSync(server, { recursive: true });

// Verify standalone build
if (!existsSync(standalone)) {
  console.error('❌ No standalone build at .next/standalone — run next build first');
  process.exit(1);
}

// ── Frontend (loader HTML for Tauri webview) ──
//
// The loader probes a range of ports because the Rust sidecar may have
// picked something other than 3001 when 3001 was taken. It reads
// `window.__O8_PORT_HINT__` first (the sidecar injects this via the
// `additional_browser_args`/window-state plumbing if available), then falls
// back to probing 3001-3050. Once a port responds, it navigates there.
const loaderHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Cortex IDE</title>
  <style>
    body {
      margin: 0; background: #09090b; color: #fafafa;
      font-family: -apple-system, system-ui, sans-serif;
      display: flex; align-items: center; justify-content: center;
      height: 100vh; flex-direction: column; gap: 16px;
    }
    .orb {
      width: 48px; height: 48px; border-radius: 14px;
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 20px;
      animation: pulse 1.5s ease infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.6; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.05); }
    }
    p { color: #71717a; font-size: 13px; }
  </style>
  <script>
    // Port candidates — start at the last port the Tauri sidecar allocated
    // (injected via __O8_PORT_HINT__ when available), then fan out across
    // the probe range the sidecar uses.
    const HINT = typeof window.__O8_PORT_HINT__ === 'number' ? window.__O8_PORT_HINT__ : null;
    const PROBE_RANGE = [];
    for (let p = 3001; p < 3050; p++) PROBE_RANGE.push(p);
    const CANDIDATES = HINT ? [HINT, ...PROBE_RANGE.filter(p => p !== HINT)] : PROBE_RANGE;

    let attempts = 0;
    let candidateIndex = 0;

    async function probe(port) {
      try {
        await fetch('http://127.0.0.1:' + port + '/api/panel/status', { mode: 'no-cors' });
        window.location.href = 'http://127.0.0.1:' + port + '/dashboard';
        return true;
      } catch { return false; }
    }

    async function tick() {
      attempts++;
      // Walk the candidate list once per tick, stop at the first hit.
      for (let i = 0; i < CANDIDATES.length; i++) {
        const port = CANDIDATES[(candidateIndex + i) % CANDIDATES.length];
        if (await probe(port)) return;
      }
      if (attempts < 30) {
        setTimeout(tick, 500);
      } else {
        document.getElementById('status').innerHTML =
          'Server failed to start.<br><br>' +
          '<span style="color:#94a3b8;font-size:12px">Make sure Node.js is installed (v22+): ' +
          '<a href="https://nodejs.org" style="color:#60a5fa">nodejs.org</a></span>';
      }
    }

    setTimeout(tick, 500);
  </script>
</head>
<body>
  <div class="orb">C</div>
  <p id="status">Starting Cortex IDE…</p>
</body>
</html>`;
writeFileSync(join(frontend, 'index.html'), loaderHtml);
console.log('📦 Created frontend loader (port-probing)');

// ── Server bundle ──
// server.js + package.json
for (const f of ['server.js', 'package.json']) {
  const src = join(standalone, f);
  if (existsSync(src)) cpSync(src, join(server, f));
}

// node_modules
const mods = join(standalone, 'node_modules');
if (existsSync(mods)) {
  cpSync(mods, join(server, 'node_modules'), { recursive: true });
  console.log('📦 Copied node_modules');
}

// .next (server chunks + static)
const nextDir = join(standalone, '.next');
if (existsSync(nextDir)) {
  cpSync(nextDir, join(server, '.next'), { recursive: true });
}
cpSync(staticDir, join(server, '.next', 'static'), { recursive: true });
console.log('📦 Copied .next');

// public
if (existsSync(pub)) {
  cpSync(pub, join(server, 'public'), { recursive: true });
  console.log('📦 Copied public');
}

// ── Copy native modules + create Turbopack hash symlinks ──
const nativeModules = ['better-sqlite3', 'node-pty'];
for (const mod of nativeModules) {
  const src = join(root, 'node_modules', mod);
  const dest = join(server, 'node_modules', mod);
  if (existsSync(src) && !existsSync(dest)) {
    cpSync(src, dest, { recursive: true });
    console.log(`📦 Copied native module: ${mod}`);
  }
}

// ── Compile WS server ──
const { execSync } = await import('child_process');

// Turbopack renames externals with hash suffixes — create symlinks
const chunksDir = join(server, '.next', 'server', 'chunks');
if (existsSync(chunksDir)) {
  try {
    const grepResult = execSync(`grep -roh "better-sqlite3-[a-f0-9]*" "${chunksDir}" 2>/dev/null | head -1`, { encoding: 'utf-8' }).trim();
    if (grepResult) {
      const aliasPath = join(server, 'node_modules', grepResult);
      if (!existsSync(aliasPath)) {
        // Copy instead of symlink — Tauri bundler doesn't follow symlinks
        cpSync(join(server, 'node_modules', 'better-sqlite3'), aliasPath, { recursive: true });
        console.log(`📦 Copied better-sqlite3 → ${grepResult} (Turbopack alias)`);
      }
    }
  } catch (e) { console.warn('⚠️  Symlink step:', e.message); }
}

// Shared esbuild args for standalone server bundles (ws-server + MCP).
//
// `server-only` is a Next.js marker package — Next resolves it via a webpack
// alias, but esbuild can't find it on its own. At runtime in a Node process
// it's a no-op, so we point the import at a bare empty module. This MUST be
// wired up, otherwise ws-server.ts silently fails to compile and the packaged
// app ships without a WS server → client spams /ws → error storm → 100% CPU
// next-server hang. See cortex-ide debugging session 2026-04-11.
//
// ESM banner also needs to synthesize `__filename` / `__dirname` / `require`
// because a handful of CJS deps (e.g. source-map-support) reference them at
// module level. Without the shim the bundle throws
// `ReferenceError: __filename is not defined` the moment it loads.
const SERVER_ONLY_STUB = join(root, 'scripts', 'server-only-stub.js');
const ESM_BANNER = [
  'import { createRequire as __o8_createRequire } from "module";',
  'import { fileURLToPath as __o8_fileURLToPath } from "url";',
  'import { dirname as __o8_dirname } from "path";',
  'const require = __o8_createRequire(import.meta.url);',
  'const __filename = __o8_fileURLToPath(import.meta.url);',
  'const __dirname = __o8_dirname(__filename);',
].join(' ');
const SHARED_ESBUILD_ARGS = [
  '--bundle',
  '--platform=node',
  '--format=esm',
  `--alias:server-only=${SERVER_ONLY_STUB}`,
  `--banner:js='${ESM_BANNER}'`,
].join(' ');

// Standalone server compiles are LOAD-BEARING for the packaged app. If any
// fail, fail the whole prebuild — don't warn-and-ship a broken bundle.
function compileServerBundle(label, entry, extraArgs = '') {
  try {
    execSync(
      `npx esbuild ${entry} ${SHARED_ESBUILD_ARGS} --outfile=out/server/${label}.mjs ${extraArgs}`,
      { cwd: root, stdio: 'inherit' },
    );
    console.log(`📦 Compiled ${label}.mjs`);
  } catch (e) {
    console.error(`❌ ${label} compilation failed — refusing to ship a broken bundle`);
    console.error(`   ${e.message}`);
    process.exit(1);
  }
}

// Native modules must be external — esbuild can't bundle .node addons.
// better-sqlite3 is used by the db layer (imported transitively through
// repo registry + lane tables) and node-pty is used by the terminal bridge.
const NATIVE_EXTERNALS = '--external:node-pty --external:better-sqlite3 --external:bindings';

compileServerBundle('ws-server', 'src/ws-server.ts', NATIVE_EXTERNALS);

// ── Compile MCP servers ──
// Ships alongside the bundled Next.js backend so the packaged Tauri app
// can expose MCP tools to Claude Desktop/Code without requiring `tsx` or
// a source checkout. See docs/cortex-v2-dogfood-report-2026-04-09.md.
compileServerBundle('operator-mcp-server', 'src/lib/mcp/operator-mcp-server.ts', NATIVE_EXTERNALS);
compileServerBundle('cortex-mcp-server', 'src/lib/mcp/cortex-mcp-server.ts', NATIVE_EXTERNALS);

// ── Sanity check: every expected standalone bundle must exist ──
// Belt-and-braces guard against future compile failures slipping through.
const REQUIRED_BUNDLES = ['ws-server.mjs', 'operator-mcp-server.mjs', 'cortex-mcp-server.mjs'];
for (const bundle of REQUIRED_BUNDLES) {
  const bundlePath = join(server, bundle);
  if (!existsSync(bundlePath)) {
    console.error(`❌ Missing required server bundle: ${bundle}`);
    process.exit(1);
  }
}

const size = execSync(`du -sh "${server}" 2>/dev/null`).toString().trim().split('\\t')[0];
console.log('\\n✅ Export complete');
console.log(`   frontend/ → loader HTML`);
console.log(`   server/ → ${size}`);
