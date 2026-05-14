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
  <title>o8</title>
  <style>
    :root {
      --paper: #F4F2ED;
      --ink: #111111;
      --ink-muted: #777777;
      --ink-quiet: #9A968E;
      --accent: #FF5A1F;
      --hairline: rgba(17, 17, 17, 0.18);
      --dot: rgba(17, 17, 17, 0.055);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      background: var(--paper);
      background-image: radial-gradient(circle at 1px 1px, var(--dot) 1px, transparent 0);
      background-size: 24px 24px;
      color: var(--ink);
      font-family: "Inter", "Neue Haas Grotesk", "Söhne", system-ui, -apple-system, sans-serif;
      font-weight: 400;
      letter-spacing: -0.01em;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      gap: 48px;
      -webkit-font-smoothing: antialiased;
      color-scheme: only light;
    }
    .mono {
      font-family: "iA Writer Mono", "JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace;
    }
    .topbar {
      position: fixed; top: 0; left: 0; right: 0;
      display: flex; align-items: baseline; gap: 14px;
      padding: 20px 28px;
      font-size: 11px;
      color: var(--ink-muted);
      letter-spacing: 0.22em;
      text-transform: uppercase;
      font-weight: 500;
    }
    .topbar .brand { color: var(--ink); letter-spacing: -0.01em; text-transform: none; font-size: 13px; font-weight: 500; }
    .topbar .sep { flex: 1; height: 1px; background: var(--hairline); opacity: 0.6; margin-top: 8px; }
    .topbar .stamp { font-size: 10px; letter-spacing: 0; text-transform: none; color: var(--ink-quiet); }

    .center {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 28px;
    }
    .section-label {
      font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase;
      color: var(--ink-muted); font-weight: 500;
    }
    .mark {
      font-size: clamp(72px, 12vw, 140px);
      line-height: 0.9;
      font-weight: 500;
      letter-spacing: -0.04em;
      color: var(--ink);
      display: flex; align-items: baseline; gap: 0;
    }
    .mark .eight {
      position: relative;
      display: inline-block;
    }
    .mark .eight::after {
      content: ""; position: absolute; right: -16px; top: 12px;
      width: 10px; height: 10px; border-radius: 50%;
      background: var(--accent);
      animation: pulse 1.6s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 0.35; transform: scale(0.85); }
      50% { opacity: 1; transform: scale(1); }
    }

    .ticker {
      display: flex; align-items: center; gap: 10px;
      font-size: 11px; color: var(--ink-muted);
      letter-spacing: 0.04em; text-transform: uppercase;
      min-height: 14px;
    }
    .ticker .bracket { color: var(--ink); }
    .ticker .dot-row { display: inline-flex; gap: 3px; }
    .ticker .dot-row span {
      width: 4px; height: 4px; border-radius: 50%;
      background: var(--ink-muted); opacity: 0.3;
      animation: step 1.4s ease-in-out infinite;
    }
    .ticker .dot-row span:nth-child(2) { animation-delay: 0.2s; }
    .ticker .dot-row span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes step {
      0%, 100% { opacity: 0.3; }
      40% { opacity: 1; }
    }

    .footer {
      position: fixed; bottom: 0; left: 0; right: 0;
      display: flex; justify-content: space-between; align-items: center;
      padding: 20px 28px;
      font-size: 10px; color: var(--ink-quiet);
      letter-spacing: 0.04em;
    }
    .footer .grid { display: flex; gap: 28px; }
  </style>
  <script>
    const HINT = typeof window.__O8_PORT_HINT__ === 'number' ? window.__O8_PORT_HINT__ : null;
    const PROBE_RANGE = [];
    for (let p = 3001; p < 3050; p++) PROBE_RANGE.push(p);
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
        await fetch('http://127.0.0.1:' + port + '/api/panel/status', { mode: 'no-cors' });
        window.location.href = 'http://127.0.0.1:' + port + '/dashboard';
        return true;
      } catch { return false; }
    }

    async function tick() {
      attempts++;
      for (let i = 0; i < CANDIDATES.length; i++) {
        const port = CANDIDATES[i];
        if (await probe(port)) return;
      }
      if (attempts < 30) {
        setTimeout(tick, 500);
      } else {
        const fail = document.getElementById('stage');
        if (fail) fail.innerHTML = '<span style="color:#FF5A1F">server failed to start — install node 22+ at <span style="color:#111">nodejs.org</span></span>';
      }
    }
    setTimeout(tick, 500);
  </script>
</head>
<body>
  <div class="topbar">
    <span class="brand">o8</span>
    <span class="sep"></span>
    <span>00 — BOOT</span>
    <span class="stamp mono" id="stamp">v0.1.16 · 00:00:00</span>
  </div>

  <div class="center">
    <span class="section-label">01 — COLD START</span>
    <div class="mark">
      o<span class="eight">8</span>
    </div>
    <div class="ticker mono">
      <span class="bracket" id="stage">(NODE)  probing runtime</span>
      <span class="dot-row"><span></span><span></span><span></span></span>
    </div>
  </div>

  <div class="footer mono">
    <span>orchestrator governance layer</span>
    <div class="grid">
      <span>codex</span>
      <span>claude</span>
      <span>gemini</span>
      <span>opencode</span>
    </div>
  </div>
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
// Builds cli/dist/o8.mjs via the package's own esbuild config, then copies it
// into out/server/bin/o8. The Tauri sidecar symlinks /usr/local/bin/o8 → that
// path on first launch so the user (and dispatched workers) have `o8` on PATH.
const CLI_BUILD = join(root, 'cli', 'esbuild.config.mjs');
const CLI_OUTPUT = join(root, 'cli', 'dist', 'o8.mjs');
const CLI_BIN_DIR = join(server, 'bin');
const CLI_BIN_DST = join(CLI_BIN_DIR, 'o8');
if (existsSync(CLI_BUILD)) {
  console.log('   building cli bundle…');
  execSync(`node "${CLI_BUILD}"`, { stdio: 'inherit', cwd: join(root, 'cli') });
  if (!existsSync(CLI_OUTPUT)) {
    console.error(`❌ CLI build did not produce ${CLI_OUTPUT}`);
    process.exit(1);
  }
  mkdirSync(CLI_BIN_DIR, { recursive: true });
  cpSync(CLI_OUTPUT, CLI_BIN_DST);
  execSync(`chmod +x "${CLI_BIN_DST}"`);
} else {
  console.warn('⚠️  CLI build config missing — skipping `o8` cli bundle');
}

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
