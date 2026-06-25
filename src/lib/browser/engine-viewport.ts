/**
 * The headless engine's render viewport. The panel live-view maps the human's
 * click/scroll coordinates against this to drive the real Chrome page, so the
 * engine and the panel must agree on it — shared here so they can't drift.
 */
export const ENGINE_VIEWPORT = { width: 1180, height: 740 } as const;
