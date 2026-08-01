'use client';

/**
 * O8EnginePane — the Browser pane's fallback surface for pages the iframe can't
 * embed (auth-gated SPAs like Clerk that reject a proxied origin and blank out).
 *
 * It drives the page in the engine's REAL headless Chrome and renders a polled
 * JPEG live-view. The human's clicks / keys / scroll are mapped into engine
 * viewport coordinates and forwarded to /api/browser/engine/act, so they can
 * sign in and navigate. Because it's the same engine session agents drive, the
 * page is also agent-readable + grabbable (o8_browser_* with surface:'engine').
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ENGINE_VIEWPORT } from '@/lib/browser/engine-viewport';

async function engineAct(scope: string, action: string, extra: Record<string, unknown> = {}): Promise<{ ok?: boolean; error?: unknown }> {
  try {
    const res = await fetch('/api/browser/engine/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, action, ...extra }),
    });
    return (await res.json()) as { ok?: boolean; error?: unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const PRESS_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

export function O8EnginePane({
  url,
  agentGlow = false,
  scope = 'operator',
  closeOnUnmount = false,
}: {
  url: string;
  agentGlow?: boolean;
  scope?: string;
  closeOnUnmount?: boolean;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const openedTargetRef = useRef<string | null>(null);
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState<'opening' | 'live' | 'error'>('opening');
  const [error, setError] = useState<string | null>(null);
  const [surfaceVisible, setSurfaceVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [pageVisible, setPageVisible] = useState(() => (
    typeof document === 'undefined' || document.visibilityState !== 'hidden'
  ));

  useEffect(() => {
    const node = wrapRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      setSurfaceVisible(Boolean(entry?.isIntersecting));
    }, { threshold: 0 });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // Open only while this pane is on screen. O8 keeps inactive utility tabs
  // mounted to preserve their state, so opening from a hidden pane wastes a
  // Chrome session and starts screenshot polling the operator cannot see.
  useEffect(() => {
    if (!surfaceVisible || !pageVisible) return;
    const target = `${scope}\n${url}`;
    if (openedTargetRef.current === target) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setStatus('opening');
      setError(null);
    });
    void engineAct(scope, 'open', { url }).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        openedTargetRef.current = target;
        setStatus('live');
        setTick((t) => t + 1);
      } else {
        setStatus('error');
        setError(typeof r.error === 'string' ? r.error : 'the engine could not open this page');
      }
    });
    return () => { cancelled = true; };
  }, [pageVisible, scope, surfaceVisible, url]);

  useEffect(() => () => {
    if (closeOnUnmount) void engineAct(scope, 'close');
  }, [closeOnUnmount, scope]);

  // Poll the live-view frame only while the app and pane are visible.
  useEffect(() => {
    if (status !== 'live' || !surfaceVisible || !pageVisible) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), 1200);
    return () => clearInterval(timer);
  }, [pageVisible, status, surfaceVisible]);

  // Pull a couple of frames quickly so the human sees their action land.
  const refreshSoon = useCallback(() => {
    setTick((t) => t + 1);
    window.setTimeout(() => setTick((t) => t + 1), 180);
    window.setTimeout(() => setTick((t) => t + 1), 480);
  }, []);

  const toViewport = (clientX: number, clientY: number) => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const x = Math.round((clientX - rect.left) * (ENGINE_VIEWPORT.width / rect.width));
    const y = Math.round((clientY - rect.top) * (ENGINE_VIEWPORT.height / rect.height));
    return {
      x: Math.max(0, Math.min(ENGINE_VIEWPORT.width, x)),
      y: Math.max(0, Math.min(ENGINE_VIEWPORT.height, y)),
    };
  };

  const handleClick = useCallback((event: React.MouseEvent) => {
    wrapRef.current?.focus();
    const point = toViewport(event.clientX, event.clientY);
    if (!point) return;
    void engineAct(scope, 'click', point).then(refreshSoon);
  }, [refreshSoon, scope]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      void engineAct(scope, 'type', { text: event.key }).then(refreshSoon);
    } else if (PRESS_KEYS.has(event.key)) {
      event.preventDefault();
      void engineAct(scope, 'press', { key: event.key }).then(refreshSoon);
    }
  }, [refreshSoon, scope]);

  const handleWheel = useCallback((event: React.WheelEvent) => {
    void engineAct(scope, 'scroll', { deltaY: Math.round(event.deltaY) }).then(refreshSoon);
  }, [refreshSoon, scope]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#fff',
        boxShadow: agentGlow ? 'inset 0 0 0 1.5px rgba(245,158,11,0.75)' : 'none',
        transition: 'box-shadow 200ms ease-out',
      }}
    >
      <div style={{
        flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
        height: 26, paddingLeft: 10, paddingRight: 10,
        background: 'var(--t-hover)', borderBottom: '1px solid var(--t-divider)',
        fontSize: 11, color: 'var(--t-text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: status === 'live' ? '#22c55e' : status === 'error' ? '#ef4444' : '#f59e0b',
        }} />
        {status === 'opening'
          ? 'Opening in the headless engine…'
          : status === 'error'
            ? (error || 'Engine error')
            : 'Headless engine — this app blocks embedding. Click & type to drive it.'}
      </div>
      <div
        ref={wrapRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onWheel={handleWheel}
        style={{
          position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden',
          outline: 'none', cursor: status === 'live' ? 'crosshair' : 'default', background: '#fff',
        }}
      >
        {status === 'live' ? (
          // eslint-disable-next-line @next/next/no-img-element -- no-store engine frames cannot use the image optimizer.
          <img
            ref={imgRef}
            src={`/api/browser/engine/view?scope=${encodeURIComponent(scope)}&t=${tick}`}
            alt="Engine live view"
            draggable={false}
            decoding="async"
            onClick={handleClick}
            style={{ display: 'block', width: '100%', height: 'auto' }}
          />
        ) : (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            paddingLeft: 24, paddingRight: 24, textAlign: 'center', fontSize: 12, color: 'var(--t-text-muted)',
          }}>
            {status === 'error' ? (error || 'The engine could not open this page.') : 'Opening…'}
          </div>
        )}
      </div>
    </div>
  );
}
