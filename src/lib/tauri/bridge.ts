/**
 * Tauri Bridge — TypeScript wrapper for Rust commands.
 *
 * All Tauri-specific code lives here. Components import from this module
 * and get graceful fallbacks when running in browser mode.
 *
 * Usage:
 *   import { isTauri, getDesktopInfo, notify } from '@/lib/tauri/bridge';
 *   if (isTauri()) { ... }
 */

// ── Detection ──

/**
 * Check if we're running inside Tauri (desktop app) vs browser.
 * Uses the Tauri internals global that the Rust shell injects.
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// ── MCP Plugin Init ──
// Register the Tauri MCP event handlers so query_page, execute_js, etc. work.
// Must run once on page load inside the Tauri webview.
let _mcpInitialized = false;
export async function initMcpPlugin(): Promise<void> {
  if (_mcpInitialized || !isTauri()) return;
  _mcpInitialized = true;
  try {
    const { setupPluginListeners } = await import('tauri-plugin-mcp');
    await setupPluginListeners();
    console.log('[tauri-bridge] MCP plugin listeners registered');
  } catch (err) {
    console.error('[tauri-bridge] MCP plugin init failed:', err);
  }
}

// ── Types ──

export interface DesktopInfo {
  is_desktop: boolean;
  platform: string;
  version: string;
  arch: string;
}

export interface SidecarResult {
  ok: boolean;
  pid: number | null;
  error: string | null;
}

// ── Commands (lazy-loaded to avoid import errors in browser) ──

/**
 * Invoke a Tauri command. Returns null if not running in Tauri.
 */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return await tauriInvoke<T>(cmd, args);
  } catch (err) {
    console.error(`[tauri-bridge] invoke ${cmd} failed:`, err);
    return null;
  }
}

/**
 * Get desktop environment info (platform, version, arch).
 */
export async function getDesktopInfo(): Promise<DesktopInfo | null> {
  return invoke<DesktopInfo>('get_desktop_info');
}

/**
 * Check if a port is listening.
 */
export async function checkPort(port: number): Promise<boolean> {
  const result = await invoke<boolean>('check_port', { port });
  return result ?? false;
}

/**
 * Start the WebSocket server as a background sidecar.
 */
export async function startWsServer(projectDir: string): Promise<SidecarResult | null> {
  return invoke<SidecarResult>('start_ws_server', { projectDir });
}

/**
 * Check if Cortex binary is available on this machine.
 */
export async function cortexAvailable(): Promise<boolean> {
  const result = await invoke<boolean>('cortex_available');
  return result ?? false;
}

/**
 * Get the app's persistent data directory.
 */
export async function getAppDataDir(): Promise<string | null> {
  return invoke<string>('get_app_data_dir');
}

// ── Notifications ──

/**
 * Send a native desktop notification.
 * Falls back to nothing in browser mode.
 */
export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { sendNotification } = await import('@tauri-apps/plugin-notification');
    sendNotification({ title, body });
  } catch {
    // Notification plugin not available
  }
}

// ── Window Management ──

/**
 * Show the main window (useful after tray-hide).
 */
export async function showWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.show();
    await win.setFocus();
  } catch {
    // Window API not available
  }
}

/**
 * Minimize the main window to tray.
 */
export async function hideWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().hide();
  } catch {
    // Window API not available
  }
}

// ── Store (Persistent Settings) ──

/**
 * Get a value from Tauri's persistent store.
 */
export async function storeGet<T>(key: string): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load('settings.json', { defaults: {} });
    const value = await store.get<T>(key);
    return value ?? null;
  } catch {
    return null;
  }
}

/**
 * Set a value in Tauri's persistent store.
 */
export async function storeSet<T>(key: string, value: T): Promise<void> {
  if (!isTauri()) return;
  try {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load('settings.json', { defaults: {} });
    await store.set(key, value);
    await store.save();
  } catch {
    // Store not available
  }
}
