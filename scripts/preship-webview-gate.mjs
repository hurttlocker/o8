#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

// Per-phase deadlines (each phase gets its OWN fresh budget — a shared budget
// let a slow cold boot under machine load starve the later route/health checks
// and flaky-fail the gate). Generous so a loaded build machine still boots the
// child in time; a genuinely-broken app still fails when its phase deadline expires.
const SOCKET_TIMEOUT_MS = 60_000;   // socket file + first connect (Next cold-spawn + bind)
const ROUTE_TIMEOUT_MS = 120_000;   // webview window created + /dashboard route active
const HEALTH_TIMEOUT_MS = 60_000;   // dashboard reaches the interactive mark, no error page
const ERROR_WINDOW_MS = 8_000;
const POLL_MS = 250;
const REQUEST_TIMEOUT_MS = 10_000;
const RELEASE_NOTE_FILE = 'preship-webview-gate-release-note.txt';

class WebviewSocketClient {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.tokenPath = `${socketPath}.token`;
    this.socket = null;
    this.buffer = '';
    this.pending = new Map();
  }

  dispose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('socket closed'));
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = null;
    this.buffer = '';
  }

  async connectOnly() {
    const socket = net.createConnection({ path: this.socketPath });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.destroy();
  }

  async send(command, payload) {
    await this.ensureConnected();
    const id = `${Date.now()}${Math.random().toString(36).slice(2)}`;
    // The tauri-plugin-mcp socket runs UNAUTHENTICATED when no auth_token is
    // configured — the operator app writes no `.token` sidecar by default.
    // Only attach a token if one actually exists; otherwise connect without.
    const authToken = existsSync(this.tokenPath) ? readFileSync(this.tokenPath, 'utf8').trim() : undefined;
    const message = authToken ? { command, payload, id, authToken } : { command, payload, id };
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${command}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.write(`${JSON.stringify(message)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async ensureConnected() {
    if (this.socket && !this.socket.destroyed) return;
    const socket = net.createConnection({ path: this.socketPath });
    this.socket = socket;
    this.buffer = '';
    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
    });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
  }

  handleData(chunk) {
    this.buffer += chunk.toString();
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  handleLine(line) {
    const response = JSON.parse(line);
    const id = typeof response.id === 'string' && this.pending.has(response.id)
      ? response.id
      : this.pending.keys().next().value;
    if (!id) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    if (response.success === false) {
      pending.reject(new Error(String(response.error ?? 'webview command failed')));
    } else {
      pending.resolve(response.data);
    }
  }
}

function parseArgs() {
  let mode = 'fail-fast';
  let target;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--mode=')) mode = arg.slice('--mode='.length);
    else target = arg;
  }
  if (mode !== 'fail-fast' && mode !== 'authoritative') {
    throw new Error(`unsupported mode: ${mode}`);
  }
  return { mode, target };
}

function packageInfo() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { version: String(pkg.version), gitSha };
}

function releaseNotePath(appTar) {
  return appTar ? path.join(path.dirname(appTar), RELEASE_NOTE_FILE) : null;
}

function clearReleaseNote(appTar) {
  const marker = releaseNotePath(appTar);
  if (marker && existsSync(marker)) unlinkSync(marker);
}

function writeBypassReleaseNote(appTar, reason) {
  const marker = releaseNotePath(appTar);
  if (!marker) return;
  writeFileSync(marker, `gate:bypassed - ${reason}\n`);
}

function liveDataDir() {
  return path.join(os.homedir(), '.o8');
}

function jsonlAuditPath() {
  return path.join(liveDataDir(), 'preship-gate-audit.jsonl');
}

function writeJsonlAudit(payload) {
  mkdirSync(liveDataDir(), { recursive: true });
  appendFileSync(jsonlAuditPath(), `${JSON.stringify({ ...payload, recordedAt: new Date().toISOString() })}\n`);
  console.error(`[preship-webview-gate] approval DB write failed; wrote JSONL audit: ${jsonlAuditPath()}`);
}

function writeAudit(payload) {
  if (payload.mode !== 'authoritative') return;
  const input = JSON.stringify(payload);
  try {
    execFileSync('npx', ['tsx', 'scripts/preship-gate-audit.ts'], {
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        O8_DATA_DIR: liveDataDir(),
        CORTEX_IDE_DATA_DIR: liveDataDir(),
      },
    });
    return;
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? String(error);
    console.error(`[preship-webview-gate] approval DB write failed:\n${stderr}`);
  }
  writeJsonlAudit(payload);
}

function tail(text, max = 12_000) {
  return text.length > max ? text.slice(text.length - max) : text;
}

function normalizeEvalResult(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return String(value ?? '');
  if (typeof value.result === 'string') return value.result;
  if (typeof value.text === 'string') return value.text;
  if ('data' in value) return normalizeEvalResult(value.data);
  return String(value);
}

async function executeJs(client, code) {
  return normalizeEvalResult(await client.send('execute_js', { window_label: 'main', code }));
}

async function invokeTauri(client, command) {
  const code = `(() => { try {
    if (!window.__TAURI_INTERNALS__ || typeof window.__TAURI_INTERNALS__.invoke !== 'function') {
      return JSON.stringify({ ok: false, err: 'tauri internals unavailable' });
    }
    return window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)})
      .then((r) => JSON.stringify({ ok: true, data: r }))
      .catch((e) => JSON.stringify({ ok: false, err: String(e && e.message || e) }));
  } catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message || e) }); } })()`;
  let parsed = JSON.parse(await executeJs(client, code));
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  if (!parsed || parsed.ok !== true) throw new Error(parsed?.err || `tauri invoke '${command}' failed`);
  return parsed.data;
}

async function waitForSocket(client, deadline) {
  while (Date.now() < deadline) {
    // Wait only on the socket itself — no `.token` sidecar exists unless an
    // auth_token is configured (the default is unauthenticated).
    if (existsSync(client.socketPath)) {
      try {
        await client.connectOnly();
        return;
      } catch (error) {
        if (!['ECONNREFUSED', 'ENOENT'].includes(error?.code)) throw error;
      }
    }
    await sleep(POLL_MS);
  }
  throw new Error('socket warmup timed out');
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function findFreePortFrom(start) {
  for (let p = start; p < start + 200; p += 1) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`no free port from ${start}`);
}

async function waitForDashboard(client, deadline) {
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const route = await invokeTauri(client, 'o8_view_active_route');
      if (typeof route?.pathname === 'string' && route.pathname.includes('/dashboard')) {
        return route.pathname;
      }
    } catch (error) {
      // Transient during boot — the webview window may not exist yet
      // ("Webview window not found: main") or the socket may reset. Keep
      // polling; a genuinely dead app fails when the deadline expires.
      lastErr = error?.message ?? String(error);
    }
    await sleep(POLL_MS);
  }
  throw new Error(`dashboard route did not become active${lastErr ? ` (last error: ${lastErr})` : ''}`);
}

async function waitForHealthyBoot(client, deadline) {
  // Authoritative boot-health signal: the dashboard must reach the
  // `o8:dashboard:interactive` perf mark — set only after a FULL, healthy mount
  // (scheduled in DashboardInner's mount effect). The `data-mcp-scope` root is
  // too weak: it's present even in a half-booted shell that hasn't run its
  // effects. If Next.js renders its "Application error" page (a propagated crash
  // — the 0.1.252 class showed exactly this), fail immediately. Never reaching
  // interactive (blank / hang / crash-before-interactive) fails at the deadline.
  const code = "(function(){var b=document.body;if(b&&b.innerText&&b.innerText.indexOf('Application error')!==-1)return 'app-error';return performance.getEntriesByName('o8:dashboard:interactive').length>0?'ready':'pending';})()";
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const result = await executeJs(client, code);
      if (result === 'app-error') throw new Error('dashboard rendered the Next.js "Application error" page');
      if (result === 'ready') return;
    } catch (error) {
      const msg = error?.message ?? String(error);
      // A real "Application error" verdict must propagate; transient eval
      // errors (window not ready / busy JS) are tolerated until the deadline.
      if (msg.indexOf('Application error') !== -1) throw error;
      lastErr = msg;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`dashboard never reached the interactive mark${lastErr ? ` (last error: ${lastErr})` : ''}`);
}

async function collectFatalConsoleErrors(client) {
  const seen = new Set();
  const fatal = [];
  const deadline = Date.now() + ERROR_WINDOW_MS;
  while (Date.now() < deadline) {
    let data;
    try {
      data = await invokeTauri(client, 'o8_view_console_errors');
    } catch {
      // transient read failure — keep polling within the window
      await sleep(POLL_MS);
      continue;
    }
    for (const error of data?.errors ?? []) {
      // Ignore benign sources: mandated [feature] console.error logging, and
      // the tauri-plugin-mcp bridge's own per-command trace
      // ([mcp-entered]/[mcp-pre]/[mcp-resolved]) that the gate's OWN probing
      // generates. A genuine uncaught crash arrives via a window 'error' event
      // (source = a real filename) or 'unhandledrejection' — neither of which
      // is filtered here.
      if (error?.source === 'console.error' || error?.source === 'tauri-plugin-mcp') continue;
      const key = `${error?.message ?? ''}\n${error?.source ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fatal.push({
        message: String(error?.message ?? ''),
        source: String(error?.source ?? ''),
        lineno: Number(error?.lineno ?? 0),
      });
    }
    if (fatal.length > 0) return fatal;
    await sleep(POLL_MS);
  }
  return fatal;
}

function resolveAppTarget(mode, target) {
  if (mode !== 'authoritative') {
    return {
      appPath: target ?? path.join('src-tauri', 'target', 'release', 'bundle', 'macos', 'o8.app'),
      cleanupDir: null,
      appTar: null,
    };
  }
  if (!target) throw new Error('--mode=authoritative requires the o8.app.tar.gz path');
  const cleanupDir = mkdtempSync(path.join(os.tmpdir(), 'o8-preship-app-'));
  execFileSync('tar', ['-xzf', target, '-C', cleanupDir], { stdio: 'inherit' });
  return { appPath: path.join(cleanupDir, 'o8.app'), cleanupDir, appTar: target };
}

function listenerGone(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

async function killProcessGroup(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await sleep(3000);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

async function cleanup({ client, child, dataDir, appCleanupDir, socketPath }) {
  client?.dispose();
  await killProcessGroup(child);
  const apiPortPath = dataDir ? path.join(dataDir, 'api-port') : null;
  const apiPort = apiPortPath && existsSync(apiPortPath) ? Number(readFileSync(apiPortPath, 'utf8')) : null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  rmSync(socketPath, { force: true });
  rmSync(`${socketPath}.token`, { force: true });
  if (appCleanupDir) rmSync(appCleanupDir, { recursive: true, force: true });
  if (apiPort && !(await listenerGone(apiPort))) {
    throw new Error(`child API port still has a listener after cleanup: ${apiPort}`);
  }
}

function bypass(mode, appTar, info) {
  const reason = (process.env.O8_GATE_BYPASS_REASON ?? '').trim();
  if (!reason) {
    console.error('[preship-webview-gate] O8_SKIP_WEBVIEW_GATE=1 requires non-empty O8_GATE_BYPASS_REASON');
    process.exit(1);
  }
  if (mode === 'authoritative') {
    writeBypassReleaseNote(appTar, reason);
    writeAudit({
      outcome: 'BYPASS',
      version: info.version,
      gitSha: info.gitSha,
      mode,
      nodeVersion: process.version,
      overrideReason: reason,
      operatorUser: os.userInfo().username,
    });
  }
  console.error([
    '',
    '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
    '[preship-webview-gate] WKWebView boot gate BYPASSED',
    `reason: ${reason}`,
    'This release proceeds without the real WKWebView pre-ship check.',
    '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
    '',
  ].join('\n'));
}

async function main() {
  const started = Date.now();
  const { mode, target } = parseArgs();
  const info = packageInfo();
  const resolved = resolveAppTarget(mode, target);
  if (mode === 'authoritative') clearReleaseNote(resolved.appTar);
  if (process.env.O8_SKIP_WEBVIEW_GATE === '1') {
    bypass(mode, resolved.appTar, info);
    if (resolved.cleanupDir) rmSync(resolved.cleanupDir, { recursive: true, force: true });
    return;
  }

  const machO = path.join(resolved.appPath, 'Contents', 'MacOS', 'o8');
  if (!existsSync(machO)) throw new Error(`missing app executable: ${machO}`);
  const socketPath = path.join(os.tmpdir(), `o8-preship-gate-${process.pid}-${Date.now()}.sock`);
  rmSync(socketPath, { force: true });
  rmSync(`${socketPath}.token`, { force: true });
  if (existsSync(socketPath)) throw new Error(`socket path already exists: ${socketPath}`);
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-bootgate-'));
  // Provision distinct free ports for the isolated child so it can never bind
  // (or be confused with) the operator's live :3001/:3002.
  const apiPort = await findFreePortFrom(3060);
  const wsPort = await findFreePortFrom(apiPort + 1);
  const client = new WebviewSocketClient(socketPath);
  let child;
  let stdout = '';
  let stderr = '';
  let signalFailed = 'unknown';
  let capturedConsoleErrors = [];

  try {
    child = spawn(machO, [], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        O8_TAURI_MCP_SOCKET: socketPath,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_DATA_DIR: dataDir,
        O8_FORCE_BUNDLED_SERVERS: '1',
        O8_PRESHIP_GATE: '1',
        O8_API_PORT: String(apiPort),
        O8_WS_PORT: String(wsPort),
        O8_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    child.stdout.on('data', (chunk) => { stdout = tail(stdout + chunk.toString()); });
    child.stderr.on('data', (chunk) => { stderr = tail(stderr + chunk.toString()); });

    signalFailed = 'socket-warmup';
    await waitForSocket(client, Date.now() + SOCKET_TIMEOUT_MS);
    signalFailed = 'dashboard-route';
    const dashboardRoute = await waitForDashboard(client, Date.now() + ROUTE_TIMEOUT_MS);
    signalFailed = 'dashboard-boot-health';
    await waitForHealthyBoot(client, Date.now() + HEALTH_TIMEOUT_MS);
    signalFailed = 'webview-console-errors';
    capturedConsoleErrors = await collectFatalConsoleErrors(client);
    if (capturedConsoleErrors.length > 0) {
      throw new Error('uncaught webview error captured');
    }

    writeAudit({
      outcome: 'PASS',
      version: info.version,
      gitSha: info.gitSha,
      mode,
      dashboardRoute,
      interactiveElapsedMs: Date.now() - started,
      nodeVersion: process.version,
    });
    console.log(`[preship-webview-gate] PASS real WKWebView booted ${path.basename(resolved.appPath)} in ${Date.now() - started}ms`);
  } catch (error) {
    writeAudit({
      outcome: 'FAIL',
      version: info.version,
      gitSha: info.gitSha,
      mode,
      nodeVersion: process.version,
      signalFailed,
      capturedConsoleErrors,
      childStderrTail: tail(stderr),
    });
    console.error(`[preship-webview-gate] FAIL signal=${signalFailed}: ${error?.message ?? error}`);
    if (capturedConsoleErrors.length > 0) {
      console.error('[preship-webview-gate] captured non-console errors:');
      console.error(JSON.stringify(capturedConsoleErrors, null, 2));
    }
    console.error(`[preship-webview-gate] child stderr tail:\n${tail(stderr)}`);
    console.error(`[preship-webview-gate] child stdout tail:\n${tail(stdout)}`);
    process.exitCode = 1;
  } finally {
    await cleanup({ client, child, dataDir, appCleanupDir: resolved.cleanupDir, socketPath });
  }
}

await main().catch((error) => {
  console.error(`[preship-webview-gate] FATAL: ${error?.message ?? error}`);
  process.exit(1);
});
