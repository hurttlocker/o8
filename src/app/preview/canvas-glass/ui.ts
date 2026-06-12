import type { CSSProperties } from 'react';

/** Shared primitives for the canvas-glass test page (#1232). */

export const FONT = 'var(--font-sans-system)';

/** The one glass recipe — every surface consumes the tunable vars. */
export function glass(deep = false): CSSProperties {
  return {
    background: deep ? 'var(--cnv-tint-deep)' : 'var(--cnv-tint)',
    backdropFilter: 'blur(var(--cnv-frost)) saturate(var(--cnv-sat, 1.6))',
    WebkitBackdropFilter: 'blur(var(--cnv-frost)) saturate(var(--cnv-sat, 1.6))',
    border: '1px solid var(--cnv-edge)',
    color: 'var(--cnv-ink)',
    boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
  } as CSSProperties;
}

/** Floating menus/popovers that sit OVER text need a near-solid back —
 *  plain glass tint lets the content underneath bleed through the rows. */
export function glassPop(): CSSProperties {
  return {
    ...glass(true),
    // Layered: a near-opaque slate base under the tunable tint. Popovers
    // stay in the glass family but never let text read through them.
    background: 'linear-gradient(var(--cnv-tint-deep), var(--cnv-tint-deep)), rgba(13, 16, 21, 0.88)',
  } as CSSProperties;
}

export type CardKind = 'packet' | 'browser' | 'terminal' | 'review' | 'image';

export interface MockCard {
  id: number;
  kind: CardKind;
  title: string;
  meta: string;
  tone: 'working' | 'waiting' | 'idle';
  x: number;
  y: number;
  /** Entry-animation stagger (s) — set for arc fan-outs. */
  entryDelay?: number;
  /** Object URL for kind 'image'. */
  src?: string;
}

export const TONE_DOT: Record<MockCard['tone'], string> = {
  working: '#22c55e',
  waiting: '#f59e0b',
  idle: 'rgba(255,255,255,0.4)',
};

export const CARD_WIDTH: Record<CardKind, number> = {
  packet: 210,
  browser: 270,
  terminal: 252,
  review: 252,
  image: 200,
};

/**
 * Terminal-card constants live HERE, not in terminal-card.tsx — a module
 * that exports non-component values breaks the Fast Refresh boundary, and
 * every edit to it would remount the live terminals (detach/re-attach churn).
 * terminal-card.tsx must export only the component (+ types).
 */
export const TERM_MIN_W = 340;
export const TERM_MIN_H = 190;
/** Image cards resize aspect-locked from the corner grip. */
export const IMG_MIN_W = 120;
export const IMG_MAX_SPAWN_EDGE = 340;
/** DEV ONLY — title-bar veil slider for dialing the terminal glass; freeze
 *  the chosen value into the default and flip this off before graduating. */
export const DEV_TERM_GLASS_TUNER = true;

/** Compact relative age for rails + history rows ("4m ago"). */
export function relAge(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'now';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** One past orchestrator thread (mobile threads API, thoughts-* store). */
export interface CanvasThreadRow {
  id: string;
  title: string | null;
  repoPath: string | null;
  repoName: string | null;
  lastMessageAt: string | null;
  messageCount?: number;
}

/** One running-orchestrator row in the side dock switcher. */
export interface OrchestratorLane {
  id: string;
  label: string;
  repo: string;
  tone: MockCard['tone'];
}

/** A single entry in a docked conversation (id-less authoring shape).
 *  `live` text = real orchestrator deltas (grows in place, no word-fade). */
export type NewDockEntry =
  | { role: 'user'; text: string }
  /** kind 'tool' = a live activity cluster — text is the latest tool name
   *  while pending, count is how many calls it has absorbed. One row per
   *  work phase, not one per call. */
  | { role: 'status'; text: string; pending: boolean; kind?: 'tool'; count?: number }
  | { role: 'result'; title: string; meta: string }
  | { role: 'text'; text: string; live?: boolean }
  | { role: 'followups' };

export type DockEntry = NewDockEntry & { id: number };
