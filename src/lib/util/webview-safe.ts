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

export function safeRequestIdleCallback(
  cb: IdleRequestCallback,
  opts?: SafeRequestIdleCallbackOptions,
): SafeIdleCallbackHandle {
  if (
    typeof window !== 'undefined' &&
    typeof window.requestIdleCallback === 'function' &&
    typeof window.cancelIdleCallback === 'function'
  ) {
    return window.requestIdleCallback(cb, opts) as SafeIdleCallbackHandle;
  }

  const fallbackDelayMs = opts?.fallbackDelayMs ?? 0;
  if (typeof window !== 'undefined') {
    return window.setTimeout(() => {
      (cb as () => void)();
    }, fallbackDelayMs) as SafeIdleCallbackHandle;
  }

  return setTimeout(() => {
    (cb as () => void)();
  }, fallbackDelayMs) as unknown as SafeIdleCallbackHandle;
}

export function safeCancelIdleCallback(handle: SafeIdleCallbackHandle): void {
  if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle);
    return;
  }

  if (typeof window !== 'undefined') {
    window.clearTimeout(handle);
    return;
  }

  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}
