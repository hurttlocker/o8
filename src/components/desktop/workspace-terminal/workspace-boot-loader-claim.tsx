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

// Synthetic FIRST-PAINT claim (prod boot recording 2026-07-17): real claims
// only mount in post-hydration effects, so the server-rendered dashboard
// painted ~1.2s of naked chrome between the bundled splash's navigation and
// the first claim. The store now boots with one synthetic claim held from
// module load (and getServerSnapshot returns true), so the loader is IN the
// SSR HTML and owns the window from the dashboard's first paint. The Host
// releases it in its own effect — parent effects run after children's, so
// every mount-time real claim is already counted and the handoff never drops
// to a rendered zero.
let firstPaintClaimHeld = false;
if (typeof window !== 'undefined') {
  claimCount = 1;
  firstPaintClaimHeld = true;
}

function releaseFirstPaintClaim() {
  if (!firstPaintClaimHeld) return;
  firstPaintClaimHeld = false;
  claimCount -= 1;
  if (claimCount === 0 && !settleTimer && !bootCompleted) {
    settleTimer = setTimeout(() => {
      settleTimer = null;
      bootCompleted = true;
    }, BOOT_SETTLE_MS);
  }
  notify();
}

// One-way boot latch (Q video 2026-07-17: "flash and flash and flash" — the
// full UI rendered, then a LATE claim re-summoned the full-screen splash over
// it seconds later). The full-screen loader belongs to BOOT only: once every
// claim has released and stayed released through the settle window, the boot
// is done and later claims become no-ops — late restores paint their own
// in-place shimmers instead of blanking a working UI. The settle window keeps
// the designed rapid claim handoffs between boot phases working.
const BOOT_SETTLE_MS = 1500;
let bootCompleted = false;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function notify() {
  for (const listener of listeners) listener();
}

export function claimBootLoader(): () => void {
  if (bootCompleted) return () => {};
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
  claimCount += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claimCount -= 1;
    if (claimCount === 0 && !settleTimer) {
      settleTimer = setTimeout(() => {
        settleTimer = null;
        bootCompleted = true;
      }, BOOT_SETTLE_MS);
    }
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

/** Mount ONCE at the dashboard root — renders the loader while claims exist.
 *  Server snapshot is TRUE: the loader is server-rendered into the dashboard
 *  HTML (backed by the synthetic first-paint claim on the client) so the
 *  splash covers the pre-hydration chrome from the very first paint. */
export function WorkspaceBootLoaderHost() {
  const active = useSyncExternalStore(subscribe, getSnapshot, () => true);
  useEffect(() => {
    // Runs AFTER all child/sibling mount effects — every boot phase that
    // claims on mount is already counted, so releasing the first-paint claim
    // here can never drop the count to a rendered zero mid-boot. The settle
    // window bridges any later async claim handoffs.
    releaseFirstPaintClaim();
  }, []);
  return active ? <WorkspaceBootLoader /> : null;
}
