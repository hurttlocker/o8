import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/** Keep receiving every chunk, but spend fewer paints on background transcripts. */
export function useTranscriptTextFlush(commit: () => void, visible: boolean) {
  const visibleRef = useRef(visible);
  const pendingRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    pendingRef.current = false;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  const flush = useCallback(() => {
    cancel();
    pendingRef.current = false;
    commit();
  }, [cancel, commit]);
  const foreground = useCallback(() => visibleRef.current
    && (typeof document === 'undefined' || document.visibilityState !== 'hidden'), []);
  const schedule = useCallback(() => {
    pendingRef.current = true;
    if (frameRef.current !== null || timerRef.current !== null) return;
    if (foreground()) {
      if (typeof requestAnimationFrame === 'undefined') flush();
      else frameRef.current = requestAnimationFrame(flush);
    } else {
      timerRef.current = setTimeout(flush, 1000);
    }
  }, [flush, foreground]);
  const reconcileVisibility = useCallback(() => {
    if (!pendingRef.current) return;
    cancel();
    if (foreground()) flush();
    else schedule();
  }, [cancel, flush, foreground, schedule]);
  useLayoutEffect(() => {
    visibleRef.current = visible;
    reconcileVisibility();
  }, [reconcileVisibility, visible]);
  useEffect(() => {
    document.addEventListener('visibilitychange', reconcileVisibility);
    return () => {
      document.removeEventListener('visibilitychange', reconcileVisibility);
      pendingRef.current = false;
      cancel();
    };
  }, [cancel, reconcileVisibility]);
  return { flush, schedule, cancel };
}
