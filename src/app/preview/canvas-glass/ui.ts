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

/** One running-orchestrator row in the side dock switcher. */
export interface OrchestratorLane {
  id: string;
  label: string;
  repo: string;
  tone: MockCard['tone'];
}

/** A single entry in a docked conversation (id-less authoring shape). */
export type NewDockEntry =
  | { role: 'user'; text: string }
  | { role: 'status'; text: string; pending: boolean }
  | { role: 'result'; title: string; meta: string }
  | { role: 'text'; text: string }
  | { role: 'followups' };

export type DockEntry = NewDockEntry & { id: number };
