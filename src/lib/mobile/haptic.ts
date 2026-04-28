/**
 * haptic.ts — Tactile feedback for mobile (PWA / Tauri webview).
 *
 * iOS apps feel right when they buzz at the moments your finger expects feedback.
 * The PWA can do this via `navigator.vibrate(ms)`. Cheap to add, big perceived-quality bump.
 *
 * Five named intensities mapped to vibration patterns:
 *   - tick     (5ms)            — list scroll snaps, sidebar slide, pull-to-refresh threshold
 *   - tap      (10ms)           — button press (cards, nav items, sheets)
 *   - success  (20ms)           — approve / send / save
 *   - warn     ([10, 30, 10])   — reject / interrupt / dangerous action
 *   - error    ([20, 60, 20])   — failure paths
 *
 * Master toggle via mobile Settings → Permissions → Haptic feedback.
 * Storage key: `o8:mobile:haptic-enabled` (with backward-compat for the older
 * `cortex-ide:mobile:haptic` key). On unsupported devices, all calls are no-ops.
 *
 * iOS Safari supports `navigator.vibrate` only in standalone PWA mode. Devices
 * without vibrate support get silent no-ops (no errors).
 */

export type HapticIntensity = 'tick' | 'tap' | 'success' | 'warn' | 'error';

const PATTERNS: Record<HapticIntensity, number | number[]> = {
  tick: 5,
  tap: 10,
  success: 20,
  warn: [10, 30, 10],
  error: [20, 60, 20],
};

export const HAPTIC_STORAGE_KEY = 'o8:mobile:haptic-enabled';
const LEGACY_STORAGE_KEY = 'cortex-ide:mobile:haptic';
const HAPTIC_DEFAULT_ENABLED = true;

let cachedEnabled: boolean | null = null;

function readStoredHaptic(): boolean {
  if (typeof window === 'undefined') {
    return HAPTIC_DEFAULT_ENABLED;
  }
  try {
    const stored = window.localStorage.getItem(HAPTIC_STORAGE_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
    const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy === '1') return true;
    if (legacy === '0') return false;
  } catch {
    // localStorage unavailable — fall through to default
  }
  return HAPTIC_DEFAULT_ENABLED;
}

function persistHaptic(enabled: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HAPTIC_STORAGE_KEY, enabled ? '1' : '0');
    // Mirror to the legacy key so older surfaces stay in sync.
    window.localStorage.setItem(LEGACY_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore
  }
}

function readEnabled(): boolean {
  if (cachedEnabled !== null) return cachedEnabled;
  cachedEnabled = readStoredHaptic();
  return cachedEnabled;
}

/** Trigger a haptic burst. Safe to call on any platform. */
export function triggerHaptic(intensity: HapticIntensity = 'tap') {
  if (typeof window === 'undefined') return;
  if (!readEnabled()) return;
  const nav = window.navigator as Navigator & { vibrate?: (pattern: number | number[]) => boolean };
  if (typeof nav.vibrate !== 'function') return;
  try {
    nav.vibrate(PATTERNS[intensity]);
  } catch {
    // Some browsers throw when vibrate() is called outside a user-gesture
    // handler. Silently swallow — this is decoration, not a hard requirement.
  }
}

/** Set the master toggle. Persists to localStorage. */
export function setHapticEnabled(enabled: boolean) {
  cachedEnabled = enabled;
  persistHaptic(enabled);
}

/** Read the current master-toggle value. Reads localStorage on first call. */
export function isHapticEnabled(): boolean {
  return readEnabled();
}

/**
 * `useHaptic()` — returns a stable trigger function. Use this in components.
 *
 * Example:
 *   const haptic = useHaptic();
 *   <button onClick={() => { haptic('tap'); doThing(); }}>…</button>
 */
export function useHaptic() {
  // Return the module-level function directly — it's already stable, reads
  // from a cached singleton, and self-detects platform support. No hook
  // state needed; this keeps the API allocation-free at every call site.
  return triggerHaptic;
}
