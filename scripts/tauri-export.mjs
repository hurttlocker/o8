#!/usr/bin/env node
/**
 * Tauri prebuild — splits the build into:
 *   out/frontend/  → Tauri frontendDist (just the loader HTML)
 *   out/server/    → Tauri bundle resource (Next.js server + Node binary)
 */
import { cpSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
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
const loaderVerifyPath = join(root, 'scripts', 'loader-verify.mjs');

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
// The loader probes the sidecar identity endpoint because any HTTP response on
// a port is not proof that it belongs to this o8 launch. It reads
// `window.__O8_PORT_HINT__` first (injected by Rust's webview initialization
// script), then falls back to the production API block.
const loaderVerifySource = readFileSync(loaderVerifyPath, 'utf-8')
  .replace(/export\s*\{\s*verifyIdentityResponse\s*\};?\s*$/m, '');
const loaderHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>o8</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      background: #0a0a0a;
      color: #f4f4f5;
      font-family: "Inter", system-ui, -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
      color-scheme: only dark;
    }
    .mono { font-family: "iA Writer Mono", "JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace; }
    #ascii { position: fixed; inset: 0; display: block; }
    .bootbar {
      position: fixed; bottom: 0; left: 0; right: 0;
      display: flex; justify-content: space-between; align-items: center;
      padding: 18px 26px;
      font-size: 10.5px; letter-spacing: 0.05em;
      color: rgba(244, 244, 245, 0.34);
      pointer-events: none;
    }
    .bootbar .left { display: flex; align-items: center; gap: 10px; }
    .bootbar .brand { color: rgba(244, 244, 245, 0.74); font-weight: 500; letter-spacing: -0.01em; }
    .bootbar .dot-row { display: inline-flex; gap: 3px; }
    .bootbar .dot-row span {
      width: 3px; height: 3px; border-radius: 50%;
      background: rgba(244, 244, 245, 0.5); opacity: 0.3;
      animation: step 1.4s ease-in-out infinite;
    }
    .bootbar .dot-row span:nth-child(2) { animation-delay: 0.2s; }
    .bootbar .dot-row span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes step { 0%, 100% { opacity: 0.25; } 40% { opacity: 0.9; } }
  </style>
  <script>
    ${loaderVerifySource}

    const HINT = typeof window.__O8_PORT_HINT__ === 'number' ? window.__O8_PORT_HINT__ : null;
    const EXPECTED_BOOT_ID = typeof window.__O8_EXPECTED_BOOT_ID__ === 'string' ? window.__O8_EXPECTED_BOOT_ID__ : '';
    const PROBE_RANGE = [];
    for (let p = 47100; p <= 47104; p++) PROBE_RANGE.push(p);
    const CANDIDATES = HINT ? [HINT, ...PROBE_RANGE.filter(p => p !== HINT)] : PROBE_RANGE;

    const STAGES = [
      '(NODE)  probing runtime',
      '(PORT)  locating sidecar',
      '(DB)    opening ledger',
      '(WS)    warming sockets',
      '(AGENT) spinning orchestrator',
    ];
    let stageIndex = 0;
    let attempts = 0;

    function updateStamp() {
      const el = document.getElementById('stamp');
      if (!el) return;
      const n = new Date();
      el.textContent = 'v' + (window.__O8_VERSION__ || 'dev') + ' · ' +
        String(n.getHours()).padStart(2,'0') + ':' +
        String(n.getMinutes()).padStart(2,'0') + ':' +
        String(n.getSeconds()).padStart(2,'0');
    }
    setInterval(updateStamp, 1000);
    updateStamp();

    function rotateStage() {
      const el = document.getElementById('stage');
      if (!el) return;
      el.textContent = STAGES[stageIndex % STAGES.length];
      stageIndex++;
    }
    setInterval(rotateStage, 900);
    rotateStage();

    async function probe(port) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/api/setup/identity', {
          method: 'GET',
          cache: 'no-store',
        });
        if (!response.ok) return false;
        const identity = await response.json();
        if (!verifyIdentityResponse(identity, EXPECTED_BOOT_ID)) return false;
        window.location.href = 'http://127.0.0.1:' + port + '/dashboard';
        return true;
      } catch { return false; }
    }

    // Poll cadence: ramp tight -> relaxed instead of a flat 500ms grid.
    // A probe against a port nothing is listening on fails instantly
    // (ECONNREFUSED), so the early attempts are nearly free — and the moment the
    // sidecar binds we want to SEE it, not sit dark waiting out the rest of a
    // 500ms tick. Same ~15s ceiling as the old 30 x 500ms.
    const BACKOFF_MS = [25, 25, 50, 50, 75, 100, 150, 200, 250, 350, 500];
    const DEADLINE_MS = 15000;
    const startedAt = Date.now();

    async function tick() {
      for (let i = 0; i < CANDIDATES.length; i++) {
        const port = CANDIDATES[i];
        if (await probe(port)) return;
      }
      if (Date.now() - startedAt < DEADLINE_MS) {
        const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
        attempts++;
        setTimeout(tick, delay);
      } else {
        const fail = document.getElementById('stage');
        if (fail) fail.innerHTML = '<span style="color:#FF5A1F">server failed to start — install node 22+ at <span style="color:#111">nodejs.org</span></span>';
      }
    }
    // Probe immediately. The window now paints before the sidecar is spawned, so
    // a 500ms head start is pure dead time on the critical path.
    tick();
  </script>
</head>
<body>
  <canvas id="ascii"></canvas>
  <div class="bootbar mono">
    <span class="left">
      <span class="brand">o8</span>
      <span id="stage">(NODE)  probing runtime</span>
      <span class="dot-row"><span></span><span></span><span></span></span>
    </span>
    <span id="stamp">v0.1.16 · 00:00:00</span>
  </div>
  <script>
    (function () {
      var cv = document.getElementById('ascii');
      var ctx = cv.getContext('2d');
      var CFG = { text: 'o8', cell: 6, scale: 0.4, color: '#ffffff', bg: '#0a0a0a', speed: 1.0, baseLevel: 0.5, waveBoost: 0.85, contrast: 1.2, ripple: 33 / 50, radiusFrac: 0.04 };
      var RAMP = ' .:-=+*#%@';
      var dpr = 1, W = 0, H = 0, cols = 0, rows = 0, lum = null;
      var cx = -1, cy = -1;
      var off = document.createElement('canvas');
      function build() {
        W = window.innerWidth; H = window.innerHeight;
        dpr = Math.min(window.devicePixelRatio || 1, 3);
        cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
        cv.style.width = W + 'px'; cv.style.height = H + 'px';
        cols = Math.max(8, Math.floor(W / CFG.cell));
        rows = Math.max(8, Math.floor(H / CFG.cell));
        lum = new Float32Array(cols * rows);
        off.width = cols; off.height = rows;
        var o = off.getContext('2d', { willReadFrequently: true });
        o.fillStyle = '#000'; o.fillRect(0, 0, cols, rows);
        o.fillStyle = '#fff'; o.textBaseline = 'middle'; o.textAlign = 'center';
        var size = rows * CFG.scale;
        function font(s) { return '700 ' + s + 'px ui-sans-serif, system-ui, -apple-system, sans-serif'; }
        o.font = font(size);
        var w = o.measureText(CFG.text).width;
        var maxW = cols * 0.86, maxH = rows * 0.86;
        if (w > maxW) size = size * (maxW / w);
        if (size > maxH) size = maxH;
        o.font = font(size);
        o.fillText(CFG.text, cols / 2, rows / 2);
        var d = o.getImageData(0, 0, cols, rows).data;
        for (var k = 0; k < cols * rows; k++) {
          var a = d[4 * k + 3] / 255;
          lum[k] = ((0.299 * d[4 * k] + 0.587 * d[4 * k + 1] + 0.114 * d[4 * k + 2]) / 255) * a;
        }
      }
      build();
      window.addEventListener('resize', build);
      window.addEventListener('pointermove', function (e) { cx = e.clientX / CFG.cell; cy = e.clientY / CFG.cell; });
      window.addEventListener('pointerleave', function () { cx = -1; cy = -1; });
      var last = RAMP.length - 1;
      var start = null;
      function frame(ts) {
        if (start === null) start = ts;
        var t = (ts - start) / 1000;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = CFG.bg; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = CFG.color;
        ctx.font = CFG.cell + 'px ui-monospace, Menlo, monospace';
        ctx.textBaseline = 'top'; ctx.textAlign = 'left';
        var span = cols + rows * 0.4;
        var edge = ((t * CFG.speed * 0.25) % 1.4) * span;
        var bw = cols * 0.1, bw2 = 2 * bw * bw;
        var rad = CFG.radiusFrac * Math.min(cols, rows), rad2 = 2 * rad * rad;
        var inside = cx >= 0;
        for (var j = 0; j < rows; j++) {
          var y = j * CFG.cell, rowOff = j * cols;
          for (var i = 0; i < cols; i++) {
            var base = lum[rowOff + i];
            if (base <= 0.015) continue;
            var dist = i + j * 0.4 - edge;
            var crest = Math.exp(-(dist * dist) / bw2);
            var val = base * (CFG.baseLevel + crest * CFG.waveBoost);
            if (inside) {
              var dx = i - cx, dy = j - cy, d2 = dx * dx + dy * dy;
              if (d2 < rad2 * 3) { var dd = Math.sqrt(d2); val = val + base * CFG.ripple * Math.exp(-d2 / rad2) * Math.sin(dd * 0.7 - t * 7); }
            }
            if (val <= 0.02) continue;
            if (val > 1) val = 1;
            var idx = Math.round(Math.pow(val, CFG.contrast) * last);
            if (idx <= 0) continue;
            var ch = RAMP.charAt(idx);
            if (ch === ' ') continue;
            ctx.fillText(ch, i * CFG.cell, y);
          }
        }
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    })();
  </script>
</body>
</html>`;
writeFileSync(join(frontend, 'index.html'), loaderHtml);
console.log('📦 Created frontend loader (port-probing)');

// ── Release config: bake the device-flow GitHub OAuth client id (#1338) ──
// The client id is PUBLIC (not a secret), so embedding it in the signed build
// is correct — it's what lets a fresh install render the "Connect GitHub"
// device-flow CTA (deviceFlowEnabled in /api/panel/github-status keys off
// process.env.GITHUB_OAUTH_CLIENT_ID, which was never present in packaged
// builds). Source priority: build env var wins, else o8.release.json at the
// repo root (gitignored, deployment-specific — see o8.release.example.json).
// Absent → nothing is stamped and the packaged build behaves exactly as today.
function resolveReleaseConfig() {
  const cfg = { githubOAuthClientId: '', sentryDsn: '' };
  const cfgPath = join(root, 'o8.release.json');
  if (existsSync(cfgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      if (typeof parsed.githubOAuthClientId === 'string') {
        cfg.githubOAuthClientId = parsed.githubOAuthClientId.trim();
      }
      // Sentry crash/error reporting DSN (telemetry ruling). Bound to the exact
      // `sentryDsn` key the operator pastes into o8.release.json. Absent → the
      // packaged build stays fully dormant (no Sentry init, no network).
      if (typeof parsed.sentryDsn === 'string') {
        cfg.sentryDsn = parsed.sentryDsn.trim();
      }
      // Private feedback-intake webhook. This one IS a secret (anyone holding it
      // can post as us into the ops channel), which is why it lives here and not
      // in source — the previous hardcoded one had to be revoked.
      if (typeof parsed.feedbackWebhookUrl === 'string') {
        cfg.feedbackWebhookUrl = parsed.feedbackWebhookUrl.trim();
      }
    } catch (e) {
      console.warn('⚠️  o8.release.json parse failed — ignoring:', e.message);
    }
  }
  const fromEnv = process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
  if (fromEnv) cfg.githubOAuthClientId = fromEnv;
  const sentryFromEnv = process.env.SENTRY_DSN?.trim();
  if (sentryFromEnv) cfg.sentryDsn = sentryFromEnv;
  const feedbackFromEnv = process.env.O8_FEEDBACK_WEBHOOK_URL?.trim();
  if (feedbackFromEnv) cfg.feedbackWebhookUrl = feedbackFromEnv;
  return cfg;
}
const releaseConfig = resolveReleaseConfig();

// Stanza spliced into the server.js wrapper (same process as server-impl.js, so
// setting process.env here is visible to the Next route handlers). The `if
// (!process.env…)` guard means a real env var — dev, operator override — still
// wins over the baked value.
const RELEASE_ENV_STANZA = releaseConfig.githubOAuthClientId
  ? `\n// Device-flow public client id, baked at release build (issue #1338).\n` +
    `if (!process.env.GITHUB_OAUTH_CLIENT_ID) process.env.GITHUB_OAUTH_CLIENT_ID = ${JSON.stringify(releaseConfig.githubOAuthClientId)};\n`
  : '';
if (releaseConfig.githubOAuthClientId) {
  console.log(`📦 Baking GITHUB_OAUTH_CLIENT_ID into server.js wrapper (device flow enabled)`);
} else {
  console.log('📦 No GITHUB_OAUTH_CLIENT_ID configured — device flow stays disabled in this build');
}

// Bake the Sentry DSN so the Next server process (and, via inheritance, any
// child it spawns) inits @sentry/node. The `if (!process.env…)` guard means the
// Rust sidecar's O8_SENTRY_DSN (which it also passes to ws-server) wins when
// present. Absent → the whole telemetry stack stays dormant.
const SENTRY_ENV_STANZA = releaseConfig.sentryDsn
  ? `\n// Sentry crash/error reporting DSN, baked at release build (telemetry ruling).\n` +
    `if (!process.env.O8_SENTRY_DSN) process.env.O8_SENTRY_DSN = ${JSON.stringify(releaseConfig.sentryDsn)};\n`
  : '';
if (releaseConfig.sentryDsn) {
  console.log('📦 Baking O8_SENTRY_DSN into server.js wrapper (Sentry enabled)');
} else {
  console.log('📦 No sentryDsn configured — Sentry stays dormant in this build');
}

// Bake the private feedback-intake webhook. Absent → the in-app Report button
// fails with a clear "not configured" error rather than silently swallowing a
// report the operator just spent a minute writing.
const FEEDBACK_ENV_STANZA = releaseConfig.feedbackWebhookUrl
  ? `\n// Private feedback-intake webhook, baked at release build.\n` +
    `if (!process.env.O8_FEEDBACK_WEBHOOK_URL) process.env.O8_FEEDBACK_WEBHOOK_URL = ${JSON.stringify(releaseConfig.feedbackWebhookUrl)};\n`
  : '';
if (releaseConfig.feedbackWebhookUrl) {
  console.log('📦 Baking O8_FEEDBACK_WEBHOOK_URL into server.js wrapper (in-app Report enabled)');
} else {
  console.log('⚠️  No feedbackWebhookUrl configured — the in-app Report button will error in this build');
}

// Bake the app version so both the boot crash guard below AND the server's
// resolveAppVersion() (src/lib/telemetry/crash-store.ts) stamp the real version
// even when cwd's package.json is the minimal Next standalone one.
let bakedAppVersion = 'unknown';
try {
  bakedAppVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || 'unknown';
} catch { /* keep 'unknown' */ }
const APP_VERSION_STANZA =
  `\nif (!process.env.O8_APP_VERSION) process.env.O8_APP_VERSION = ${JSON.stringify(bakedAppVersion)};\n`;

// Early-boot crash guard (Rock 2): observe crashes that happen BEFORE Next's
// instrumentation hook installs the full crash capture. Self-contained (no
// imports of app code), best-effort, never throws. Appends the same JSONL shape
// src/lib/telemetry/crash-store.ts uses, honouring the same data-dir env vars,
// with a coarse 1MB ceiling so a boot-loop can't grow the file unbounded.
const BOOT_CAPTURE_STANZA = `
(function installBootCrashCapture() {
  try {
    const bfs = require('node:fs');
    const bos = require('node:os');
    const bpath = require('node:path');
    const dir = bpath.join(process.env.O8_DATA_DIR || process.env.CORTEX_IDE_DATA_DIR || bpath.join(bos.homedir(), '.o8'), 'telemetry');
    const file = bpath.join(dir, 'crashes.jsonl');
    const write = (kind, err) => {
      try {
        bfs.mkdirSync(dir, { recursive: true });
        try { if (bfs.existsSync(file) && bfs.statSync(file).size > 1000000) return; } catch (e) {}
        const msg = err && err.message ? err.message : String(err);
        const rec = { ts: Date.now(), source: 'boot', appVersion: process.env.O8_APP_VERSION || 'unknown', kind: kind, message: String(msg).slice(0, 2000) };
        if (err && err.stack) rec.stack = String(err.stack).slice(0, 8000);
        bfs.appendFileSync(file, JSON.stringify(rec) + '\\n', 'utf8');
      } catch (e) { /* swallow */ }
    };
    process.on('uncaughtExceptionMonitor', (err) => write('uncaughtException', err));
    process.on('unhandledRejection', (reason) => write('unhandledRejection', reason));
  } catch (e) { /* telemetry must never block boot */ }
})();
`;

// ── Server bundle ──
// Next's stock standalone entry ships as server-impl.js; server.js becomes a
// thin wrapper that stamps the REAL TCP peer address into x-o8-client-addr on
// every request (overwriting any client-supplied value) before Next sees it.
// The middleware gate treats that header as socket truth — without it, the
// loopback check rests on the spoofable Host header. The Tauri sidecar's
// process detection matches on the literal name "server.js", so the wrapper
// must keep that name.
for (const f of ['server.js', 'package.json']) {
  const src = join(standalone, f);
  if (!existsSync(src)) continue;
  if (f === 'server.js') {
    cpSync(src, join(server, 'server-impl.js'));
    continue;
  }
  cpSync(src, join(server, f));
}
writeFileSync(join(server, 'server.js'), `// o8 production entry — stamps the TCP peer address into x-o8-client-addr
// so the auth middleware can distinguish loopback from LAN without trusting
// client-controlled headers. Generated by scripts/tauri-export.mjs.

// ── V8 compile cache (Node 22+). MUST be first: it only caches what is required
// AFTER it is enabled. ──
//
// The sidecar spends a large share of its boot simply COMPILING JavaScript —
// not running it, not opening the database (better-sqlite3 is ~30ms), just
// turning bytes on disk into bytecode. Measured on the operator's Intel box,
// CPU-profiled at boot (CPU time, because wall-clock here is bimodal with page
// cache state):
//
//     compile cache OFF   CPU 1401ms   CJS loader 398ms
//     compile cache ON    CPU 1103ms   CJS loader 147ms   (-298ms, 1.27x)
//
// This is the phase the loader spins in front of, so it is time the operator
// spends watching a spinner on every single launch.
//
// Safety: the cache keys on file CONTENT, so a new build simply misses and
// repopulates — it cannot serve stale code across an update. It lives in the
// user data dir (never inside the read-only .app), and every failure is
// swallowed: this is an optimisation, never a requirement.
try {
  const { enableCompileCache } = require('node:module');
  // If NODE_COMPILE_CACHE is already in the environment, Node has ALREADY enabled
  // the cache before this file ran, and calling enableCompileCache() again would
  // be a redundant second enable of the same thing. The Tauri shell sets that env
  // var for every Node child (ws-server has no wrapper to hook, so it can only be
  // reached that way), which means the packaged app takes the env path and this
  // call is only for standalone runs -- dev, tests, \`node out/server/server.js\`.
  if (typeof enableCompileCache === 'function' && !process.env.NODE_COMPILE_CACHE) {
    const nodePath = require('node:path');
    const nodeOs = require('node:os');
    const dataDir = process.env.O8_DATA_DIR
      || process.env.CORTEX_IDE_DATA_DIR
      || nodePath.join(nodeOs.homedir(), '.o8');
    enableCompileCache(nodePath.join(dataDir, 'compile-cache'));
  }
} catch { /* never let a cache failure stop the server booting */ }

const http = require('node:http');
const https = require('node:https');

function stampClientAddr(server) {
  server.prependListener('request', (req) => {
    try {
      const peer = req.socket?.remoteAddress || '';
      const loopbackPeer = peer === '::1' || peer === '127.0.0.1' || peer.startsWith('127.') || peer.startsWith('::ffff:127.');
      // The o8 relay connector (a same-host loopback process) forwards a remote
      // phone's request and sets x-o8-relay-forward so the auth gate treats it as
      // REMOTE (Bearer required), never loopback-trusted (relay-v1 change 1).
      // Honored ONLY from a loopback peer, and it can ONLY restrict (loopback ->
      // remote), never escalate -- so it is not a spoof/escalation vector.
      // See src/lib/mobile/relay-connector.ts (RELAY_FORWARD_MARKER).
      if (loopbackPeer && req.headers['x-o8-relay-forward'] === '1') {
        req.headers['x-o8-client-addr'] = 'o8-relay-forward';
      } else {
        req.headers['x-o8-client-addr'] = peer;
      }
    } catch { /* never block a request over a stamp failure */ }
  });
  return server;
}

const origHttpCreate = http.createServer;
http.createServer = function (...args) {
  return stampClientAddr(origHttpCreate.apply(this, args));
};
const origHttpsCreate = https.createServer;
https.createServer = function (...args) {
  return stampClientAddr(origHttpsCreate.apply(this, args));
};
${RELEASE_ENV_STANZA}${SENTRY_ENV_STANZA}${FEEDBACK_ENV_STANZA}${APP_VERSION_STANZA}${BOOT_CAPTURE_STANZA}
process.env.O8_PACKAGED_APP = '1';
require('./server-impl.js');
`);
console.log('📦 Wrote server.js wrapper (socket-addr stamping) + server-impl.js');

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

// @sentry/node uses dynamic require-in-the-middle instrumentation that does not
// bundle cleanly with esbuild — keep it external so ws-server.mjs `import()`s it
// at runtime from out/server/node_modules (present via the Next standalone
// trace). A dormant build never reaches the dynamic import, so a missing module
// degrades to a no-op rather than a bundle failure.
const SENTRY_EXTERNAL = '--external:@sentry/node';

compileServerBundle('ws-server', 'src/ws-server.ts', `${NATIVE_EXTERNALS} ${SENTRY_EXTERNAL}`);

// terminal-host fork target (#1498 follow-up). ws-server forks this when
// O8_TERMINAL_HOST=child so node-pty spawn + data pump run in a separate
// process. Sits next to ws-server.mjs in out/server/ — the child resolver
// (terminal-host-client.ts) finds it via import.meta.url adjacency. Bundled
// unconditionally so flipping the env in a packaged install just works; inline
// (default) never forks it.
compileServerBundle('terminal-host', 'src/lib/ws-server/terminal-host-entry.ts', NATIVE_EXTERNALS);

// ── Compile MCP servers ──
// Ships alongside the bundled Next.js backend so the packaged Tauri app
// can expose MCP tools to Claude Desktop/Code without requiring `tsx` or
// a source checkout. See docs/cortex-v2-dogfood-report-2026-04-09.md.
compileServerBundle('operator-mcp-server-main', 'src/lib/mcp/operator-mcp-server.ts', NATIVE_EXTERNALS);
compileServerBundle('operator-mcp-server', 'src/lib/mcp/operator-mcp-server-bundle-entry.ts', NATIVE_EXTERNALS);
compileServerBundle('cortex-mcp-server', 'src/lib/mcp/cortex-mcp-server.ts', NATIVE_EXTERNALS);

// ── Copy runtime-read prompt templates next to the bundles ──
// orchestrator-session.ts resolves orchestrator.md via `import.meta.url`, so
// the file has to sit next to the bundled ws-server.mjs at runtime. In dev it
// lives alongside the source file; here we mirror it into out/server/.
const ORCHESTRATOR_PROMPT_SRC = join(root, 'src', 'lib', 'lane', 'orchestrator.md');
const ORCHESTRATOR_PROMPT_DST = join(server, 'orchestrator.md');
if (existsSync(ORCHESTRATOR_PROMPT_SRC)) {
  cpSync(ORCHESTRATOR_PROMPT_SRC, ORCHESTRATOR_PROMPT_DST);
} else {
  console.error('❌ Missing orchestrator.md at', ORCHESTRATOR_PROMPT_SRC);
  process.exit(1);
}

// Decomposition pipeline template (#538). The pipeline probes a handful of
// layout-specific locations at runtime (cwd-relative, standalone-relative,
// bundle-adjacent). Copying it to two spots covers both prod layouts — the
// Next.js standalone cwd AND the out/server root where esbuild drops the
// other runtime-read prompts.
const DECOMPOSE_PROMPT_SRC = join(root, 'src', 'lib', 'dispatch', 'prompts', 'decompose.md');
const DECOMPOSE_PROMPT_DST = join(server, 'prompts', 'decompose.md');
const DECOMPOSE_PROMPT_STANDALONE_DST = join(server, 'src', 'lib', 'dispatch', 'prompts', 'decompose.md');
if (existsSync(DECOMPOSE_PROMPT_SRC)) {
  mkdirSync(dirname(DECOMPOSE_PROMPT_DST), { recursive: true });
  cpSync(DECOMPOSE_PROMPT_SRC, DECOMPOSE_PROMPT_DST);
  mkdirSync(dirname(DECOMPOSE_PROMPT_STANDALONE_DST), { recursive: true });
  cpSync(DECOMPOSE_PROMPT_SRC, DECOMPOSE_PROMPT_STANDALONE_DST);
} else {
  // Missing the prompt is not fatal — the pipeline has an inline fallback so
  // a missed copy still enqueues packets. Warn loudly though; packaging miss.
  console.warn('⚠️  Missing decompose.md at', DECOMPOSE_PROMPT_SRC, '— pipeline will use inline fallback');
}

// ── Build + bundle the agent-facing CLI ──
// Builds cli/dist/o8.mjs via the package's own esbuild config, then writes a
// shell wrapper at out/server/bin/o8. The wrapper uses O8_NODE_BIN when the app
// injected it, then falls back to a login-shell lookup so Finder/minimal-PATH
// sessions do not fail at `#!/usr/bin/env node`.
const CLI_BUILD = join(root, 'cli', 'esbuild.config.mjs');
const CLI_OUTPUT = join(root, 'cli', 'dist', 'o8.mjs');
const CLI_BIN_DIR = join(server, 'bin');
const CLI_BIN_DST = join(CLI_BIN_DIR, 'o8');
const CLI_BUNDLE_DST = join(CLI_BIN_DIR, 'o8.mjs');
if (existsSync(CLI_BUILD)) {
  console.log('   building cli bundle…');
  execSync(`node "${CLI_BUILD}"`, { stdio: 'inherit', cwd: join(root, 'cli') });
  if (!existsSync(CLI_OUTPUT)) {
    console.error(`❌ CLI build did not produce ${CLI_OUTPUT}`);
    process.exit(1);
  }
  mkdirSync(CLI_BIN_DIR, { recursive: true });
  cpSync(CLI_OUTPUT, CLI_BUNDLE_DST);
  writeFileSync(CLI_BIN_DST, `#!/bin/sh
set -eu
# Resolve the REAL script location through symlinks — o8 is invoked via
# /usr/local/bin/o8 -> <app bundle>/server/bin/o8, and dirname "$0" alone
# pointed at /usr/local/bin, so o8.mjs was never found (every PATH invocation,
# including dispatched workers' \`o8 packet report\`, died MODULE_NOT_FOUND).
SELF="$0"
while [ -L "$SELF" ]; do
  LINK="$(readlink -- "$SELF")"
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *) SELF="$(dirname -- "$SELF")/$LINK" ;;
  esac
done
DIR="$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)"
NODE_BIN="\${O8_NODE_BIN:-}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(zsh -l -c 'command -v node' 2>/dev/null || bash -l -c 'command -v node' 2>/dev/null || sh -lc 'command -v node' 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ]; then
  echo "o8: Node.js 22+ is required. Relaunch o8.app or install Node from https://nodejs.org." >&2
  exit 127
fi
exec "$NODE_BIN" "$DIR/o8.mjs" "$@"
`);
  execSync(`chmod +x "${CLI_BIN_DST}"`);
  execSync(`chmod +x "${CLI_BUNDLE_DST}"`);
} else {
  console.warn('⚠️  CLI build config missing — skipping `o8` cli bundle');
}

// ── Sanity check: every expected standalone bundle must exist ──
// Belt-and-braces guard against future compile failures slipping through.
const REQUIRED_BUNDLES = ['ws-server.mjs', 'terminal-host.mjs', 'operator-mcp-server.mjs', 'operator-mcp-server-main.mjs', 'cortex-mcp-server.mjs'];
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
