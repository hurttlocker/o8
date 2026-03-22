#!/usr/bin/env node
/**
 * Tauri prebuild: creates an `out/` directory with a minimal shell.
 * The Tauri app starts the Next.js server as a sidecar and the shell
 * redirects to localhost:3001/dashboard once the server is ready.
 *
 * This avoids needing `output: 'export'` which is incompatible with
 * our dynamic API routes.
 */
import { mkdirSync, writeFileSync, cpSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const out = join(root, 'out');

mkdirSync(out, { recursive: true });

// Copy public assets
const pub = join(root, 'public');
if (existsSync(pub)) {
  cpSync(pub, out, { recursive: true });
}

// Shell HTML that waits for the local server and redirects
const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Cortex IDE</title>
  <style>
    body {
      margin: 0;
      background: #09090b;
      color: #fafafa;
      font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      flex-direction: column;
      gap: 16px;
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
    // Poll local server until it responds, then navigate
    const SERVER = 'http://localhost:3001';
    const TARGET = SERVER + '/dashboard';
    let attempts = 0;
    const maxAttempts = 60; // 30 seconds

    function check() {
      fetch(SERVER + '/api/panel/status', { mode: 'no-cors' })
        .then(() => { window.location.href = TARGET; })
        .catch(() => {
          attempts++;
          if (attempts < maxAttempts) {
            setTimeout(check, 500);
          } else {
            document.getElementById('status').textContent =
              'Server not responding. Start the dev server: npm run dev -- -p 3001';
          }
        });
    }
    // Start checking after a brief delay
    setTimeout(check, 800);
  </script>
</head>
<body>
  <div class="orb">C</div>
  <p id="status">Starting Cortex IDE…</p>
</body>
</html>`;

writeFileSync(join(out, 'index.html'), html);
console.log('✓ Tauri export: created out/ with shell redirect');
