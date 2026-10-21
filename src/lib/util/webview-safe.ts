type SafeRequestIdleCallbackOptions = IdleRequestOptions & {
  /**
   * Preserves existing call-site fallback timing while defaulting new callers
   * to the normal setTimeout(_, 0) webview-safe path.
   */
  fallbackDelayMs?: number;
};

declare const safeIdleCallbackHandleBrand: unique symbol;

export type SafeIdleCallbackHandle = number & {
  readonly [safeIdleCallbackHandleBrand]: true;
};

/**
 * Deterministic IdleDeadline for the setTimeout fallback path.
 *
 * The fallback is timer-driven (not a real idle slice), so `didTimeout` is
 * true and `timeRemaining()` is always 0 — callers should treat the callback
 * as "do essential work only."
 */
function createFallbackIdleDeadline(): IdleDeadline {
  return {
    didTimeout: true,
    timeRemaining() {
      return 0;
    },
  };
}

function nativeIdlePairAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.requestIdleCallback === 'function' &&
    typeof window.cancelIdleCallback === 'function'
  );
}

export function safeRequestIdleCallback(
  cb: IdleRequestCallback,
  opts?: SafeRequestIdleCallbackOptions,
): SafeIdleCallbackHandle {
  if (nativeIdlePairAvailable()) {
    return window.requestIdleCallback(cb, opts) as SafeIdleCallbackHandle;
  }

  const fallbackDelayMs = opts?.fallbackDelayMs ?? 0;
  const run = () => {
    cb(createFallbackIdleDeadline());
  };

  if (typeof window !== 'undefined') {
    return window.setTimeout(run, fallbackDelayMs) as SafeIdleCallbackHandle;
  }

  return setTimeout(run, fallbackDelayMs) as unknown as SafeIdleCallbackHandle;
}

export function safeCancelIdleCallback(handle: SafeIdleCallbackHandle): void {
  // Mirror the request gate: only cancel via the native API when both
  // requestIdleCallback and cancelIdleCallback are present. Cancel-only
  // partial support must clearTimeout the setTimeout handle from the fallback.
  if (nativeIdlePairAvailable()) {
    window.cancelIdleCallback(handle);
    return;
  }

  if (typeof window !== 'undefined') {
    window.clearTimeout(handle);
    return;
  }

  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}
