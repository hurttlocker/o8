#!/usr/bin/env node
/**
 * Tauri prebuild — splits the build into:
 *   out/frontend/  → Tauri frontendDist (just the loader HTML)
 *   out/server/    → Tauri bundle resource (Next.js server + Node binary)
 */
import { cpSync, mkdirSync, writeFileSync, existsSync, rmSync, chmodSync } from 'fs';
import { homedir } from 'os';
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
const PORT = process.env.CORTEX_IDE_PORT || '3001';
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
    const TARGET = 'http://127.0.0.1:${PORT}/dashboard';
    let attempts = 0;
    function check() {
      fetch('http://127.0.0.1:${PORT}/api/panel/status', { mode: 'no-cors' })
        .then(() => { window.location.href = TARGET; })
        .catch(() => {
          attempts++;
          if (attempts < 30) setTimeout(check, 500);
          else document.getElementById('status').innerHTML = 'Server failed to start.<br><br><span style="color:#94a3b8;font-size:12px">Make sure Node.js is installed: <a href="https://nodejs.org" style="color:#60a5fa">nodejs.org</a></span>';
        });
    }
    setTimeout(check, 500);
  </script>
</head>
<body>
  <div class="orb">C</div>
  <p id="status">Starting Cortex IDE…</p>
</body>
</html>`;
writeFileSync(join(frontend, 'index.html'), loaderHtml);
console.log('📦 Created frontend loader');

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

// ── Bundle Cortex memory binary ──
const cortexBin = join(homedir(), 'bin', 'cortex');
if (existsSync(cortexBin)) {
  const dest = join(server, 'bin', 'cortex');
  mkdirSync(join(server, 'bin'), { recursive: true });
  cpSync(cortexBin, dest);
  chmodSync(dest, 0o755);
  console.log('📦 Bundled cortex binary (memory engine)');
} else {
  console.warn('⚠️  ~/bin/cortex not found — memory features will be disabled');
}

// ── Compile WS server ──
const { execSync } = await import('child_process');
const { symlinkSync } = await import('fs');

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
try {
  execSync(
    `npx esbuild src/ws-server.ts --bundle --platform=node --format=esm --outfile=out/server/ws-server.mjs --external:node-pty --banner:js='import { createRequire } from "module"; const require = createRequire(import.meta.url);'`,
    { cwd: root, stdio: 'inherit' },
  );
  console.log('📦 Compiled ws-server.mjs');
} catch (e) {
  console.warn('⚠️  WS server compilation failed:', e.message);
}

const size = execSync(`du -sh "${server}" 2>/dev/null`).toString().trim().split('\\t')[0];
console.log('\\n✅ Export complete');
console.log(`   frontend/ → loader HTML`);
console.log(`   server/ → ${size}`);
