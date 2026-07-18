/**
 * permissions-model — pure, testable shape for the Permissions concierge tab
 * (#1342). Maps the raw Tauri bridge return values into a display status and
 * carries the per-permission metadata (why o8 needs it, the exact System
 * Settings deep-link, whether the app can fire the OS prompt itself, and
 * whether a grant only takes effect after a relaunch).
 *
 * No React / no Tauri imports here — the component wires these to live bridge
 * calls; this module stays a pure mapper so the status logic is unit-tested.
 */

export type PermId = 'microphone' | 'accessibility' | 'input-monitoring' | 'screen-recording';

/** Display status. 'not-asked' is only distinguishable for Microphone (macOS
 * AVFoundation reports notDetermined); Accessibility / Input Monitoring / Screen
 * Recording collapse never-asked into 'denied' because their preflight APIs
 * cannot tell the two apart. 'unknown' is the pre-first-read state. */
export type PermStatus = 'granted' | 'denied' | 'not-asked' | 'unknown';

export interface PermMeta {
  id: PermId;
  label: string;
  /** One-line "why o8 needs this" shown as the row subtitle. */
  why: string;
  /** Exact x-apple.systempreferences deep-link for the denied path. */
  deepLink: string;
  /** True when o8 can fire the real macOS prompt itself (mic / input monitoring);
   * false when the only path is the System Settings deep-link. */
  canPrompt: boolean;
  /** True when a fresh grant only takes effect after an app relaunch
   * (Accessibility / Input Monitoring / Screen Recording — TCC caches the
   * decision for the running process). Microphone applies live. */
  needsRelaunch: boolean;
}

// macOS System Settings deep-links — the exact Privacy_* panes.
const URL_MICROPHONE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
const URL_ACCESSIBILITY = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
const URL_INPUT_MONITORING = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent';
const URL_SCREEN_CAPTURE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/** Ordered — this is the render order in the tab. */
export const PERMISSIONS: PermMeta[] = [
  {
    id: 'microphone',
    label: 'Microphone',
    why: 'Lets you dictate and talk to Symon — audio is transcribed, never stored by o8',
    deepLink: URL_MICROPHONE,
    canPrompt: true,
    needsRelaunch: false,
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    why: 'Lets o8 see the focused window so dictation lands in the right app',
    deepLink: URL_ACCESSIBILITY,
    canPrompt: false,
    needsRelaunch: true,
  },
  {
    id: 'input-monitoring',
    label: 'Input Monitoring',
    why: 'Required for the global Fn hotkey to receive key events — stricter than Accessibility',
    deepLink: URL_INPUT_MONITORING,
    canPrompt: true,
    needsRelaunch: true,
  },
  {
    id: 'screen-recording',
    label: 'Screen Recording',
    why: "Powers Symon's screen sight — reading what's on screen to point and guide",
    deepLink: URL_SCREEN_CAPTURE,
    canPrompt: false,
    needsRelaunch: true,
  },
];

export const PERM_IDS: PermId[] = PERMISSIONS.map((p) => p.id);

export function permMeta(id: PermId): PermMeta {
  const meta = PERMISSIONS.find((p) => p.id === id);
  if (!meta) throw new Error(`[permissions] unknown permission id: ${id}`);
  return meta;
}

/** Map the Microphone bridge return (boolean | null) to a display status.
 * true → granted, false → denied/restricted, null → never asked. */
export function micStatus(granted: boolean | null | undefined): PermStatus {
  if (granted === true) return 'granted';
  if (granted === false) return 'denied';
  return 'not-asked';
}

/** Map a plain boolean grant (Accessibility / Input Monitoring / Screen
 * Recording) to a display status. These APIs cannot report never-asked, so
 * false is surfaced as 'denied'. */
export function boolStatus(granted: boolean | null | undefined): PermStatus {
  return granted === true ? 'granted' : 'denied';
}

/** The pill copy for a status. */
export function permPillText(status: PermStatus): string {
  switch (status) {
    case 'granted': return 'Granted';
    case 'denied': return 'Denied';
    case 'not-asked': return 'Not asked';
    default: return 'Checking…';
  }
}

/** The pill tone for a status (feeds ValuePill's tone prop). */
export function permPillTone(status: PermStatus): 'default' | 'success' | 'destructive' {
  if (status === 'granted') return 'success';
  if (status === 'denied') return 'destructive';
  return 'default';
}

/** The Fix-button label for a not-yet-granted permission. When the app can fire
 * the prompt AND the status is not-asked, it's a real "Allow"; otherwise the
 * only path is the System Settings deep-link. */
export function fixActionLabel(meta: PermMeta, status: PermStatus): string {
  if (meta.canPrompt && status === 'not-asked') return 'Allow…';
  return 'Open Settings';
}

/** Whether a Fix click on this permission+status should fire the OS prompt
 * (true) rather than deep-link System Settings (false). macOS only re-prompts
 * when it has never asked; a denial must go through System Settings. */
export function shouldPrompt(meta: PermMeta, status: PermStatus): boolean {
  return meta.canPrompt && status === 'not-asked';
}

/** Given the previous and next status for a permission, whether this poll tick
 * observed a fresh grant DURING the session (was actionable, flipped to
 * granted). Used to surface the relaunch affordance only for grants the user
 * just made — not permissions already granted at open. */
export function isFreshGrant(prev: PermStatus, next: PermStatus): boolean {
  return next === 'granted' && prev !== 'granted' && prev !== 'unknown';
}
