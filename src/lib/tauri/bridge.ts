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

// #932 phase 2: tauri-plugin-mcp's old setupPluginListeners() init dance
// was deleted. The eval_and_await protocol invokes JS from Rust per call
// (via webview.eval()) instead of holding persistent JS-side listeners,
// so no client-side init is required. The plugin loads automatically
// when the dev-mcp-plugin Cargo feature is on.

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

// ── Keychain ──

/**
 * Retrieve the AES-256-GCM master encryption key from the macOS Keychain.
 * Returns null if the entry does not exist or this is not a Tauri build.
 */
export async function masterKeyGet(): Promise<string | null> {
  return invoke<string>('master_key_get');
}

/**
 * Retrieve the master key from Keychain, creating one if absent.
 * Returns null on non-Tauri / non-macOS environments.
 */
export async function masterKeyEnsure(): Promise<string | null> {
  return invoke<string>('master_key_ensure');
}

// ── Voice / system-dictation permissions (P0 helpers) ──

/** Whether o8 has macOS Accessibility permission. Non-prompting. */
export async function accessibilityPermissionGranted(): Promise<boolean> {
  const result = await invoke<boolean>('accessibility_permission_granted_cmd');
  return result ?? false;
}

/** Whether o8 has macOS Input Monitoring permission. Non-prompting. */
export async function inputMonitoringGranted(): Promise<boolean> {
  const result = await invoke<boolean>('input_monitoring_granted_cmd');
  return result ?? false;
}

/**
 * The current `AppleFnUsageType` (0 = "Do Nothing" — what o8 needs). null /
 * unset should be treated as 3 = "Start Dictation", which hijacks the Fn key.
 */
export async function fnKeyUsageType(): Promise<number | null> {
  return invoke<number>('fn_key_usage_type_cmd');
}

/**
 * Whether o8 has macOS Screen Recording permission — powers Symon's screen
 * sight (Points / Guide). Per CGPreflight, which can report stale truth after
 * an app rebind; the hint copy covers the re-grant recipe. Non-prompting.
 */
export async function screenCaptureGranted(): Promise<boolean> {
  const result = await invoke<boolean>('screen_capture_granted_cmd');
  return result ?? false;
}

/**
 * Microphone TCC status: true authorized, false denied/restricted, null when
 * macOS has never asked (the first dictation will prompt). Non-prompting.
 */
export async function micPermissionGranted(): Promise<boolean | null> {
  return invoke<boolean | null>('mic_permission_granted_cmd');
}

/**
 * Open a macOS System Settings pane by its URL / bundle target. Used to jump
 * the user to Accessibility / Input-Monitoring / Keyboard for granting.
 */
export async function openSystemSettings(target: string): Promise<void> {
  await invoke('open_system_settings', { target });
}

// ── Background presence + autostart (P4) ──

/** Whether "Launch at login" is currently registered. */
export async function autostartIsEnabled(): Promise<boolean> {
  const result = await invoke<boolean>('autostart_is_enabled');
  return result ?? false;
}

/** Enable / disable "Launch at login". Returns the resulting state. */
export async function autostartSet(enabled: boolean): Promise<boolean> {
  const result = await invoke<boolean>('autostart_set', { enabled });
  return result ?? enabled;
}

/** Whether background mode (Accessory / Dock icon hidden) is on. */
export async function backgroundModeIsEnabled(): Promise<boolean> {
  const result = await invoke<boolean>('background_mode_is_enabled');
  return result ?? false;
}

/** Toggle background mode — hides/shows the Dock icon and persists the choice. */
export async function backgroundModeSet(enabled: boolean): Promise<boolean> {
  const result = await invoke<boolean>('background_mode_set', { enabled });
  return result ?? enabled;
}

/** Voice preferences (`~/.o8/dictation.json`, secrets stripped). mtime-cached
 * server-side, so a `voicePrefsSet` write applies live with no relaunch. */
export async function voicePrefsGet(): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown>>('voice_prefs_get');
}

export async function voicePrefsSet(key: string, value: unknown): Promise<void> {
  await invoke('voice_prefs_set', { key, value });
}

/** Apply the native recognizer locale live (e.g. "en-US"). Pairs with persisting
 * `dictation_locale` via voicePrefsSet so the choice survives relaunch. */
export async function sttSetLocale(locale: string): Promise<void> {
  await invoke('o8_stt_locale', { locale });
}

/** Speak `text` through the TTS engine using the currently-saved voice + speed —
 * powers the Voice Output "Preview" buttons. Fire-and-forget. */
export async function ttsSpeak(text: string): Promise<void> {
  await invoke('tts_speak', { text });
}

/** Stop any active TTS playback (preview / read-aloud). Safe no-op when idle. */
export async function ttsStop(): Promise<void> {
  await invoke('tts_stop');
}

/** An audio input device for the Settings mic picker. */
export interface InputDevice { id: string; name: string; is_default: boolean }

/** List connected audio input devices. Returns null until the Rust enumeration
 * command ships — the mic picker degrades to "System Default" in that case. */
export async function sttListInputDevices(): Promise<InputDevice[] | null> {
  return invoke<InputDevice[]>('stt_list_input_devices');
}

/** Route dictation to a specific input device (uid). No-op until shipped. */
export async function sttSetInputDevice(deviceUid: string): Promise<void> {
  await invoke('stt_set_input_device', { deviceUid });
}

// ── Symon voice agent ──

/** A persisted agent task's status (for polling the dock). */
export interface AgentTaskStatus {
  id: string;
  status: string;
  intent: string;
  result: string | null;
  model: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/** Run the Symon voice agent on a text prompt (the tool-calling lane, separate
 * from Ask). Fire-and-forget — progress + result reach the dock via events + TTS,
 * and risky actions surface a confirm card. */
export async function agentRun(prompt: string): Promise<void> {
  await invoke('agent_run', { prompt });
}

/** Resolve a pending agent confirm card (Allow / Cancel). */
export async function agentConfirm(taskId: string, allow: boolean): Promise<void> {
  await invoke('agent_confirm', { taskId, allow });
}

/** The most recent agent task (status/result). Null until one has run. */
export async function agentTaskStatus(): Promise<AgentTaskStatus | null> {
  return invoke<AgentTaskStatus>('agent_task_status');
}

/** A persisted dictation/ask, newest-first — the settings History panel. */
export interface DictationHistoryEntry {
  id: string;
  ts: number; // unix seconds
  mode: string; // "dictation" | "ask" | "speak-selection"
  text: string;
  app: string; // target app bundle id, may be empty
}

export async function dictationHistoryGet(): Promise<DictationHistoryEntry[]> {
  return (await invoke<DictationHistoryEntry[]>('dictation_history_get')) ?? [];
}

export async function dictationHistoryClear(): Promise<void> {
  await invoke('dictation_history_clear');
}

export async function dictationHistoryDelete(id: string): Promise<void> {
  await invoke('dictation_history_delete', { id });
}
