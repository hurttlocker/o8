/**
 * Quiet mode's notice policy (#2147) — the ONE place "critical" is defined.
 *
 * CANONICAL DEFINITION OF "CRITICAL": a notice is critical when suppressing it
 * could cost the operator work, or leave them unaware that o8 is blocked on
 * them. That is approvals waiting on a human, errors, and an update the app is
 * about to apply. Everything else — review-ready banners, coach cards, count
 * pills, toasts, the satellite overlay windows — is a convenience surface, and
 * quiet mode hides it.
 *
 * The native shell declares the same table in `src-tauri/src/presentation.rs`,
 * because a macOS banner is raised from Rust and never passes through this
 * module. `tests/quiet-mode-policy-parity.test.ts` reads that Rust file and
 * fails if the two drift, so "one place" survives the language boundary.
 *
 * Pure module: no React, no `server-only`, no Tauri. Both halves import it.
 */

export type QuietModeNoticeKind =
  | 'approval'
  | 'error'
  | 'update-available'
  | 'review-ready'
  | 'coach-card'
  | 'status-pill'
  | 'toast'
  | 'overlay-window';

/** Declaration order matches the Rust `NoticeKind` enum; the parity test relies on it. */
export const QUIET_MODE_NOTICE_KINDS: readonly QuietModeNoticeKind[] = Object.freeze([
  'approval',
  'error',
  'update-available',
  'review-ready',
  'coach-card',
  'status-pill',
  'toast',
  'overlay-window',
]);

/** Notices quiet mode never touches. */
export const QUIET_MODE_CRITICAL_NOTICE_KINDS: readonly QuietModeNoticeKind[] = Object.freeze([
  'approval',
  'error',
  'update-available',
]);

export function isQuietModeCriticalNotice(kind: QuietModeNoticeKind): boolean {
  return QUIET_MODE_CRITICAL_NOTICE_KINDS.includes(kind);
}

/** Whether quiet mode hides this notice. Critical notices always show. */
export function quietModeSuppresses(kind: QuietModeNoticeKind): boolean {
  return !isQuietModeCriticalNotice(kind);
}

/**
 * The question every suppressible surface actually asks: "should I render?"
 * `quietModeActive` comes from the operator default or the live client store.
 */
export function noticeIsVisible(kind: QuietModeNoticeKind, quietModeActive: boolean): boolean {
  if (!quietModeActive) return true;
  return !quietModeSuppresses(kind);
}
