'use client';

import { useSyncExternalStore } from 'react';
import { REALTIME_FALLBACK_REFRESH_MS, startDurableRefresh } from '@/lib/panel/durable-refresh';
import { safeCancelIdleCallback, safeRequestIdleCallback, type SafeIdleCallbackHandle } from '@/lib/util/webview-safe';

/**
 * One shared supervisor-inbox count for every surface that shows it (the status
 * bar badge, the branch rail's capsule). A module-level store rather than a
 * per-component hook: each mount used to own a 15s poller, so a second consumer
 * would have doubled the request rate for the same number.
 *
 * The poller runs only while something is subscribed, and stops on the last
 * unsubscribe.
 */

let humanRequiredCount = 0;
const listeners = new Set<() => void>();
let stopDurableRefresh: (() => void) | undefined;
let idleHandle: SafeIdleCallbackHandle | undefined;
let primeTimeout: number | undefined;

function emit(): void {
  for (const listener of listeners) listener();
}

function setCount(next: number): void {
  const clamped = Math.max(0, Math.floor(next));
  if (clamped === humanRequiredCount) return;
  humanRequiredCount = clamped;
  emit();
}

async function refresh(): Promise<void> {
  try {
    const response = await fetch('/api/panel/supervisor-inbox?scope=all', { cache: 'no-store' });
    if (!response.ok) return;
    const payload = (await response.json().catch(() => ({}))) as {
      summary?: { humanRequired?: unknown; active?: unknown };
    };
    const next = payload.summary?.humanRequired ?? payload.summary?.active;
    if (typeof next === 'number' && Number.isFinite(next)) setCount(next);
  } catch {
    // Surfaces should not render transient API failures as UI noise.
  }
}

function handleInboxEvent(event: Event): void {
  const detail = (event as CustomEvent<{ data?: { humanRequiredCount?: unknown } }>).detail;
  const next = detail?.data?.humanRequiredCount;
  if (typeof next === 'number' && Number.isFinite(next)) setCount(next);
  else void refresh();
}

function start(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('o8:supervisor-inbox', handleInboxEvent);
  idleHandle = safeRequestIdleCallback(() => {
    idleHandle = undefined;
    if (primeTimeout !== undefined) {
      window.clearTimeout(primeTimeout);
      primeTimeout = undefined;
    }
    void refresh();
  }, { timeout: 2500, fallbackDelayMs: 1200 });
  primeTimeout = window.setTimeout(() => {
    primeTimeout = undefined;
    if (idleHandle !== undefined) safeCancelIdleCallback(idleHandle);
    idleHandle = undefined;
    void refresh();
  }, 1200);
  stopDurableRefresh = startDurableRefresh({
    refresh,
    intervalMs: REALTIME_FALLBACK_REFRESH_MS,
  });
}

function stop(): void {
  if (typeof window === 'undefined') return;
  window.removeEventListener('o8:supervisor-inbox', handleInboxEvent);
  if (idleHandle !== undefined) safeCancelIdleCallback(idleHandle);
  idleHandle = undefined;
  if (primeTimeout !== undefined) window.clearTimeout(primeTimeout);
  primeTimeout = undefined;
  stopDurableRefresh?.();
  stopDurableRefresh = undefined;
}

function subscribe(listener: () => void): () => void {
  const wasEmpty = listeners.size === 0;
  listeners.add(listener);
  if (wasEmpty) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/** Count of inbox items that need a human. 0 = the inbox is quiet. */
export function useSupervisorInboxCount(): number {
  return useSyncExternalStore(
    subscribe,
    () => humanRequiredCount,
    () => 0,
  );
}

/** Route the operator to the inbox tab (O8Panel listens for this). */
export function openSupervisorInboxTab(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('o8:open-inbox-tab'));
}
