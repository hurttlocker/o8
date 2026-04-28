/**
 * Dashboard bootstrap perf instrumentation.
 *
 * One-shot performance.mark / performance.measure helpers for the desktop
 * dashboard so we can detect hydration-latency regressions without spinning
 * up Chrome devtools. The numbers print once per cold boot to the console
 * with the [perf] prefix:
 *
 *   [perf] dashboard bootstrap: script-start→first-render=412ms,
 *          first-render→interactive=87ms, total=499ms
 *
 * The marks are all guarded by `performance` availability so SSR and
 * non-browser test runners are silent. Each helper is idempotent — calling
 * it twice will not double-emit.
 */

const SCRIPT_START_MARK = 'o8:dashboard:script-start';
const FIRST_RENDER_MARK = 'o8:dashboard:first-render';
const INTERACTIVE_MARK = 'o8:dashboard:interactive';

let scriptStartMarked = false;
let firstRenderMarked = false;
let interactiveMarked = false;

function hasPerf(): boolean {
  return typeof performance !== 'undefined' && typeof performance.mark === 'function';
}

/** Call as early as possible at module load — before the dashboard component runs. */
export function markDashboardScriptStart(): void {
  if (scriptStartMarked || !hasPerf()) return;
  scriptStartMarked = true;
  try { performance.mark(SCRIPT_START_MARK); } catch { /* noop */ }
}

/** Call once from the dashboard's first render (during the initial mount effect). */
export function markDashboardFirstRender(): void {
  if (firstRenderMarked || !hasPerf()) return;
  firstRenderMarked = true;
  try { performance.mark(FIRST_RENDER_MARK); } catch { /* noop */ }
}

/**
 * Call once when the dashboard is interactive (heavy children mounted, first
 * round of fetches kicked off). Emits a single console line summarising the
 * three-segment bootstrap timeline. Subsequent calls are no-ops.
 */
export function markDashboardInteractive(): void {
  if (interactiveMarked || !hasPerf()) return;
  interactiveMarked = true;
  try {
    performance.mark(INTERACTIVE_MARK);
    let scriptToFirst = 0;
    let firstToInteractive = 0;
    let total = 0;
    try {
      const scriptToFirstMeasure = performance.measure(
        'o8:dashboard:script-start->first-render',
        SCRIPT_START_MARK,
        FIRST_RENDER_MARK,
      );
      scriptToFirst = Math.round(scriptToFirstMeasure.duration);
    } catch { /* mark missing */ }
    try {
      const firstToInteractiveMeasure = performance.measure(
        'o8:dashboard:first-render->interactive',
        FIRST_RENDER_MARK,
        INTERACTIVE_MARK,
      );
      firstToInteractive = Math.round(firstToInteractiveMeasure.duration);
    } catch { /* mark missing */ }
    try {
      const totalMeasure = performance.measure(
        'o8:dashboard:script-start->interactive',
        SCRIPT_START_MARK,
        INTERACTIVE_MARK,
      );
      total = Math.round(totalMeasure.duration);
    } catch { /* mark missing */ }
    // Intentional one-shot perf log so future regressions are obvious in
    // the production webview console without DevTools profiling.
    console.log(
      `[perf] dashboard bootstrap: script-start→first-render=${scriptToFirst}ms, `
        + `first-render→interactive=${firstToInteractive}ms, total=${total}ms`,
    );
  } catch { /* noop */ }
}
