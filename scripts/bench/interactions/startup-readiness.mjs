export const STARTUP_MEASUREMENT_METHOD = 'page-readiness-plus-trusted-input-paint-v1';

// Serialized before app code. Keep the readiness clock independent of protocol
// delivery, but require an actual trusted input to survive through paint.
export function installStartupReadinessProbe({ timeoutMs = 120_000 } = {}) {
  const state = { result: null };
  globalThis.__o8StartupReadiness = state;
  let candidate = null;
  let readyAt = null;
  let key = null;
  let frame = null;
  let finished = false;
  const eligible = element => element instanceof HTMLTextAreaElement
    && element.matches('textarea[data-o8-active-composer="true"]')
    && element.isConnected && !element.disabled && !element.readOnly
    && element.getClientRects().length > 0
    && (element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true })
      ?? getComputedStyle(element).visibility !== 'hidden');
  const refresh = () => {
    const target = document.querySelector('textarea[data-o8-active-composer="true"]');
    const hydrated = globalThis.__o8Interactions?.hydratedAtMs;
    if (!Number.isFinite(hydrated) || !eligible(target)) {
      candidate = null;
      readyAt = null;
    } else if (candidate !== target) {
      candidate = target;
      readyAt = performance.now();
    }
  };
  const poll = () => {
    if (finished) return;
    refresh();
    frame = requestAnimationFrame(poll);
  };
  const stop = () => {
    finished = true;
    if (frame !== null) cancelAnimationFrame(frame);
    clearTimeout(timer);
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('input', onInput, true);
  };
  const onKeydown = event => {
    if (!event.isTrusted) return;
    refresh();
    if (event.target !== candidate || !Number.isFinite(readyAt)) return;
    key = { target: candidate, readyAt, eventAt: event.timeStamp, value: candidate.value,
      hydratedAt: globalThis.__o8Interactions?.hydratedAtMs };
  };
  const onInput = event => {
    if (!event.isTrusted || !key || event.target !== key.target) return;
    const observed = key;
    stop();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const paintedAt = performance.now();
      if (!eligible(observed.target) || observed.target.value === observed.value
        || !Number.isFinite(observed.hydratedAt)
        || observed.readyAt < observed.hydratedAt || observed.eventAt < observed.readyAt) {
        state.result = { durationMs: null, note: 'trusted startup input did not retain a valid editable target through paint' };
        return;
      }
      const readinessMs = observed.readyAt - observed.hydratedAt;
      const inputPaintMs = paintedAt - observed.eventAt;
      state.result = {
        durationMs: Number((readinessMs + inputPaintMs).toFixed(2)),
        measurementMethod: 'page-readiness-plus-trusted-input-paint-v1',
        readinessMs: Number(readinessMs.toFixed(2)),
        inputPaintMs: Number(inputPaintMs.toFixed(2)),
        excludedDriverWaitMs: Number((observed.eventAt - observed.readyAt).toFixed(2)),
        hydrationToPaintWallMs: Number((paintedAt - observed.hydratedAt).toFixed(2)),
        inputTrusted: true,
      };
    }));
  };
  const timer = setTimeout(() => {
    state.result = { durationMs: null, note: 'startup readiness or trusted input was not observed within the bounded window' };
    stop();
  }, timeoutMs);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('input', onInput, true);
  frame = requestAnimationFrame(poll);
}

export function readStartupReadinessSample() {
  return globalThis.__o8StartupReadiness?.result
    ?? { durationMs: null, note: 'no startup readiness observation with trusted input paint' };
}
