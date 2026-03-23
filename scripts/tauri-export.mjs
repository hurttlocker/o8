#!/usr/bin/env node
/**
 * Tauri prebuild — bundles the Next.js standalone server into `out/`.
 *
 * Next.js `output: 'standalone'` produces a self-contained server.js
 * that includes only the node_modules needed at runtime (~15-25MB).
 * 
 * Structure:
 *   out/
 *     server.js          ← Next.js standalone server entry
 *     server/            ← compiled server chunks
 *     public/            ← static assets
 *     .next/static/      ← client bundles
 *     start.sh           ← launcher script for Tauri sidecar
 *
 * Tauri spawns `node out/server.js` as a sidecar, then loads localhost:3001.
 */
import { cpSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const out = join(root, 'out');
const standalone = join(root, '.next', 'standalone');
const staticDir = join(root, '.next', 'static');
const pub = join(root, 'public');

// Clean previous build
if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(out, { recursive: true });

// Verify standalone build exists
if (!existsSync(standalone)) {
  console.error('❌ No standalone build found at .next/standalone');
  console.error('   Run `next build` first (output: "standalone" must be in next.config.ts)');
  process.exit(1);
}

// Copy only the essential standalone files (not the whole project tree)
console.log('📦 Copying standalone server...');

// server.js + package.json
for (const f of ['server.js', 'package.json']) {
  const src = join(standalone, f);
  if (existsSync(src)) cpSync(src, join(out, f));
}

// node_modules (the minimal traced set)
const standaloneModules = join(standalone, 'node_modules');
if (existsSync(standaloneModules)) {
  cpSync(standaloneModules, join(out, 'node_modules'), { recursive: true });
  console.log('📦 Copied node_modules');
}

// .next/server (compiled server chunks — required for API routes + pages)
const serverChunks = join(standalone, '.next');
if (existsSync(serverChunks)) {
  cpSync(serverChunks, join(out, '.next'), { recursive: true });
  console.log('📦 Copied .next/server chunks');
}

// Copy static assets (client JS/CSS bundles)
const outStatic = join(out, '.next', 'static');
mkdirSync(outStatic, { recursive: true });
cpSync(staticDir, outStatic, { recursive: true });
console.log('📦 Copied .next/static');

// Copy public assets
if (existsSync(pub)) {
  cpSync(pub, join(out, 'public'), { recursive: true });
  console.log('📦 Copied public/');
}

// Create a shell launcher for the server
const PORT = process.env.CORTEX_IDE_PORT || '3001';
const launcher = `#!/bin/bash
# Cortex IDE server launcher — started by Tauri as a sidecar
cd "$(dirname "$0")"
export PORT=${PORT}
export HOSTNAME=127.0.0.1
export NODE_ENV=production
exec node server.js
`;
writeFileSync(join(out, 'start.sh'), launcher, { mode: 0o755 });

// Also create a Windows batch file for future cross-platform
const winLauncher = `@echo off
cd /d "%~dp0"
set PORT=${PORT}
set HOSTNAME=127.0.0.1
set NODE_ENV=production
node server.js
`;
writeFileSync(join(out, 'start.bat'), winLauncher);

// Create a loader HTML that Tauri shows while the server boots
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
          if (attempts < 120) setTimeout(check, 500);
          else document.getElementById('status').textContent = 'Server failed to start. Check logs.';
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
writeFileSync(join(out, 'index.html'), loaderHtml);

// Report size
const { execSync } = await import('child_process');
const size = execSync(`du -sh "${out}" 2>/dev/null || echo "unknown"`).toString().trim().split('\t')[0];
console.log(`\n✅ Tauri export complete: out/ (${size})`);
console.log('   server.js + node_modules + static assets + loader');
