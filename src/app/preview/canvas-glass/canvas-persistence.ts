'use client';

/**
 * Canvas persistence (#1232) — the canvas is a PLACE, not a session. What
 * was on it before a reload is there when you come back.
 *
 * One localStorage snapshot of every card's identity + geometry. Live
 * resources restore through their real spawn paths on mount: terminals
 * respawn fresh shells in the saved cwd, chat cards refetch their thread
 * transcript, diff cards refetch the lane diff (and silently drop if the
 * lane is gone). Browser tabs, o8.md cards, and images restore directly.
 *
 * Images carry dataURIs, so the snapshot is size-guarded: past the budget
 * the image cards are dropped from the snapshot (never the live canvas).
 */

import type { BrowserTab } from './browser-card';

const SNAPSHOT_KEY = 'o8:canvas-layout:v1';
/** localStorage quota is ~5MB; leave room for the rest of the app's keys. */
const SNAPSHOT_BYTE_BUDGET = 3_000_000;

export interface SnapGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasSnapshotV1 {
  v: 1;
  activeRepoPath: string | null;
  dockOpen: boolean;
  /** `sessionName` (#6) lets a surviving tmux-backed shell re-attach on restore
   *  instead of respawning fresh; absent on older snapshots / dead sessions. */
  term: Array<SnapGeometry & { cwd: string | null; cwdLabel: string | null; sessionName?: string | null }>;
  file: Array<SnapGeometry & { path: string }>;
  /** Optional — file tree cards arrived after v1 snapshots existed. */
  tree?: Array<SnapGeometry & { repoPath: string }>;
  image: Array<SnapGeometry & { aspect: number; items: Array<{ src: string; name: string }> }>;
  browser: Array<SnapGeometry & { tabs: BrowserTab[]; activeTabId: number }>;
  chat: Array<SnapGeometry & { threadId: string; repoPath: string | null; repoName: string | null; title: string }>;
  diff: Array<SnapGeometry & { laneId: string; title: string }>;
  spec: Array<SnapGeometry & { repoPath: string | null }>;
  /** Optional — render cards arrived after v1 snapshots existed. */
  markdown?: Array<SnapGeometry & { title: string; markdown: string }>;
  /** Optional — Brain cards arrived after v1 snapshots existed; absent
   *  means none (older snapshots stay loadable). */
  brain?: Array<SnapGeometry & { repoPath: string | null }>;
  /** Optional — video cards carry only the IndexedDB media id + name (the
   *  bytes live in canvas-media-store, never the snapshot). Absent = none. */
  video?: Array<SnapGeometry & { mediaId: string; name: string; aspect: number }>;
}

export function loadCanvasSnapshot(): CanvasSnapshotV1 | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || (parsed as { v?: number }).v !== 1) return null;
    const snap = parsed as CanvasSnapshotV1;
    for (const key of ['term', 'file', 'image', 'browser', 'chat', 'diff', 'spec'] as const) {
      if (!Array.isArray(snap[key])) return null;
    }
    return snap;
  } catch {
    return null;
  }
}

export function saveCanvasSnapshot(snapshot: CanvasSnapshotV1): void {
  if (typeof window === 'undefined') return;
  try {
    let raw = JSON.stringify(snapshot);
    if (raw.length > SNAPSHOT_BYTE_BUDGET) {
      raw = JSON.stringify({ ...snapshot, image: [] });
    }
    window.localStorage.setItem(SNAPSHOT_KEY, raw);
  } catch {
    // Quota or private-mode failure — the canvas still works, it just
    // won't survive the next reload.
  }
}
