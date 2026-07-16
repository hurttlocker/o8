'use client';

/**
 * Ref-counted boot loader — ONE continuous full-screen loader across the whole
 * boot/restore sequence instead of three separate mounts.
 *
 * The boot path used to hand off between loaders: the panels' pre-hydration
 * loader unmounted when tabs landed, the lazy OrchestratorTab chunk suspended
 * over a null fallback, and the tab's restoring shimmer mounted last — each
 * handoff flashed whatever was behind it (the empty greeting, a blank pane)
 * for a few frames (Q video, 0.1.604: "loads perfect, flashes away, shows
 * again inside the workspace").
 *
 * Now every phase renders a <WorkspaceBootLoaderClaim /> (a claim on the
 * loader, no DOM of its own) and a single <WorkspaceBootLoaderHost /> at the
 * dashboard root keeps the real WorkspaceBootLoader mounted while ANY claim is
 * live. Same-commit claim transfers never drop the count to a rendered zero,
 * so the loader never remounts — the ASCII wave and caption stay continuous.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { WorkspaceBootLoader } from './WorkspaceBootLoader';

let claimCount = 0;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function claimBootLoader(): () => void {
  claimCount += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claimCount -= 1;
    notify();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return claimCount > 0;
}

/** Renders nothing — holds a claim on the shared boot loader while mounted. */
export function WorkspaceBootLoaderClaim() {
  useEffect(() => claimBootLoader(), []);
  return null;
}

/** Mount ONCE at the dashboard root — renders the loader while claims exist. */
export function WorkspaceBootLoaderHost() {
  const active = useSyncExternalStore(subscribe, getSnapshot, () => false);
  return active ? <WorkspaceBootLoader /> : null;
}
