/**
 * #4 crash-survival — feature flag + helpers, kept in a dependency-free module so
 * both the owned-session store (the spawn path) and the lane reconciler (the boot
 * re-bind observability) can read it without importing each other's heavy graph.
 */

/**
 * Opt-in flag (default OFF). When set, owned workers spawn detached (setsid+unref)
 * instead of through the ws-server PTY bridge, so they outlive a ws-server restart
 * / full app crash. Off keeps today's bridge-primary behavior exactly. Flip the
 * default ON once Stage 2's boot re-attach has shipped and been dogfooded.
 */
export function crashSurvivableWorkersEnabled(): boolean {
  const raw = process.env.O8_CRASH_SURVIVABLE_WORKERS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}
