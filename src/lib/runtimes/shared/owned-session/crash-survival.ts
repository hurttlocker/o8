/**
 * #4 crash-survival — feature flag + helpers, kept in a dependency-free module so
 * both the owned-session store (the spawn path) and the lane reconciler (the boot
 * re-bind observability) can read it without importing each other's heavy graph.
 */

/**
 * Default ON since the live kill-test passed on 0.1.512 (worker spawned detached,
 * survived a full app crash, re-bound on relaunch). Owned workers spawn detached
 * (setsid+unref) so they outlive a ws-server restart / full app crash; boot
 * re-binds the survivor. Set `O8_CRASH_SURVIVABLE_WORKERS=0` (or false/off/no) to
 * fall back to the legacy ws-server PTY bridge (gets the raw-terminal tab back,
 * loses crash-survival). NOTE: this covers DISPATCHED AGENT WORKERS only —
 * interactive terminals + the orchestrator's in-flight turn are separate (see
 * docs/operations/daemon-crash-survival.md).
 */
export function crashSurvivableWorkersEnabled(): boolean {
  const raw = process.env.O8_CRASH_SURVIVABLE_WORKERS?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}
