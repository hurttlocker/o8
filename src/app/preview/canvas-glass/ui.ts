import type { CSSProperties } from 'react';
import { getCurveBuilder } from '@lisse/core';

/** Shared primitives for the canvas-glass test page (#1232). */

export const FONT = 'var(--font-sans-system)';

/** SVG geometry for a single squircle BOTTOM-RIGHT corner (the Figma curve,
 *  smoothing 0.6 — same family Lisse's SmoothCorners draws). The arc bulges
 *  toward bottom-right with its concave side facing top-left, so dropped just
 *  off a card's bottom-right corner it reads as a curve CONCENTRIC with the
 *  card's own corner — the off-edge resize affordance on media cards. */
function squircleCornerArc(radius: number, stroke: number): { d: string; size: number } {
  const { p, pathSegment } = getCurveBuilder('squircle')({
    cornerRadius: radius,
    smoothing: 0.6,
    exponent: 4,
    preserveSmoothing: true,
    roundingAndSmoothingBudget: radius * 4,
  });
  const pad = Math.max(1, stroke);
  const vertex = p + pad; // the sharp-corner vertex the curve bulges toward
  const d = `M ${vertex} ${vertex - p} ${pathSegment('BR')}`;
  return { d, size: p + pad * 2 };
}

/** Resize-handle arc, concentric with a media card's 18px outer corner.
 *  Computed once (radius is fixed) — cards read `.d` + `.size`. */
export const RESIZE_ARC = squircleCornerArc(18, 2.5);

/** Photo/video card frame geometry — the grey frosted frame is the card bounds;
 *  the media insets MEDIA_RIM on the sides/bottom and sits below a
 *  MEDIA_HEADER_H header strip at the top (icon + filename, reference look). */
export const MEDIA_RIM = 7;
export const MEDIA_HEADER_H = 28;

/**
 * Canvas chrome vocabulary (#1259) — ONE size/weight set for every card's
 * header: title, secondary meta, glyph icons, the ✕. Cards live inside the
 * CSS-zoom layer (default 0.7), so these pre-zoom px render ~×0.7 on screen —
 * tuned so chrome reads ~11–12px at the 100% step, matching the IDE o8.md panel
 * header, the orchestrator dock, and the dock's own ✕. Before this every card
 * hand-rolled its own 8–9.5px chrome and none of them matched. Multiply by the
 * shell's pull-out factor `s` (1 for in-layer cards) where a card already does.
 */
export const CHROME = {
  /** Card title (header label). */
  titleSize: 16,
  titleWeight: 400,
  /** Secondary meta beside/under the title (branch, status, path tail). */
  metaSize: 13,
  metaWeight: 300,
  /** Header glyph svg (dock, globe, picker, open-in-panel). */
  iconSize: 18,
  /** The ✕ glyph — sized to read like the dock's undock ✕ (~11px on screen). */
  closeSize: 16,
  /** Body field text inside a card header (url bar, tab labels) — same family. */
  fieldSize: 14,
  /**
   * Card BODY vocabulary — the one scale for a card's CONTENT text, the peer of
   * the header sizes above. Two rungs so every card reads alike at any zoom step:
   *  - bodySize: reading text (prose, transcript, code, list items, editor body)
   *  - captionSize: quiet sublines / meta / eyebrows / counts (= hurttlocker row-meta)
   * Pre-zoom px like the rest of CHROME. Route in-card content here so a markdown
   * card, a diff, and a Brain answer never read at three different sizes.
   */
  bodySize: 12.5,
  captionSize: 9.5,
} as const;

/**
 * The formal canvas-chrome scale (#1259). Interactive corner chrome — the ✕ +
 * dock/action cluster — scales WITH the canvas like content, so it stays in
 * proportion at any card size. But the clamp lifts it once the field zoom would
 * shrink it below a clickable floor, so it never gets too small to hit in a
 * zoomed-out canvas. At the 0.7 default the clamp resolves to 1 (pure
 * proportional); it only boosts when small. The 1.4 cap stops a tiny card
 * ballooning the buttons. Tune the floor via --cnv-chrome-floor. Pass the
 * transformOrigin so the cluster pins to its corner as it scales.
 *
 * Skip this for screenMap pull-out cards — those scale their chrome via `* s`
 * already and aren't inside the CSS-zoom layer, so reading --cnv-zoom here
 * would double-scale them.
 */
export function chromeFloorScale(origin: string = 'top right'): CSSProperties {
  return {
    transform: 'scale(clamp(1, calc(var(--cnv-chrome-floor, 0.64) / var(--cnv-zoom, 1)), 1.4))',
    transformOrigin: origin,
  };
}

/** The one glass recipe — every surface consumes the tunable vars.
 *  `suppressBlur` drops the live `backdrop-filter` (set true WHILE a card is
 *  dragged): a moving backdrop-filter re-samples the dark native vibrancy each
 *  frame and flickers the canvas. With it off, the static tint fill stands in
 *  for the drag; the blur returns on release, so the slider stays fully live. */
export function glass(deep = false, suppressBlur = false): CSSProperties {
  return {
    background: deep ? 'var(--cnv-tint-deep)' : 'var(--cnv-tint)',
    // --cnv-frost-scale (default 1) lets a surface scale its blur DOWN while
    // its content scrolls fast (useScrollBlurFade) — crisp in motion, full
    // frost at rest. Set per-surface, so it never touches the slider value.
    backdropFilter: suppressBlur ? 'none' : 'blur(calc(var(--cnv-frost) * var(--cnv-frost-scale, 1))) saturate(var(--cnv-sat, 1.6))',
    WebkitBackdropFilter: suppressBlur ? 'none' : 'blur(calc(var(--cnv-frost) * var(--cnv-frost-scale, 1))) saturate(var(--cnv-sat, 1.6))',
    border: '1px solid var(--cnv-edge)',
    color: 'var(--cnv-ink)',
    boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
  } as CSSProperties;
}

/** Media-card frost — the grey rim/header recipe for photo & video cards.
 *  Uses `--cnv-media-rim` (a tone-aware NEUTRAL grey, not the near-white pane
 *  tint) so the outline + header read as grey-on-white on the paper canvas.
 *  `suppressBlur` drops the live blur during a drag (see `glass`). */
export function glassMedia(suppressBlur = false): CSSProperties {
  return {
    background: 'var(--cnv-media-rim)',
    backdropFilter: suppressBlur ? 'none' : 'blur(calc(var(--cnv-frost) * var(--cnv-frost-scale, 1))) saturate(var(--cnv-sat, 1.6))',
    WebkitBackdropFilter: suppressBlur ? 'none' : 'blur(calc(var(--cnv-frost) * var(--cnv-frost-scale, 1))) saturate(var(--cnv-sat, 1.6))',
    border: '1px solid var(--cnv-edge)',
    color: 'var(--cnv-ink)',
  } as CSSProperties;
}

/** Floating orchestrator chat cards run their OWN material dial — they
 *  carry conversation ink, so the operator tunes them apart from the
 *  ambient glass (the "Floating chats" sliders in the tuner). `suppressBlur`
 *  drops the live blur during a drag (see `glass`). */
export function glassChat(suppressBlur = false): CSSProperties {
  return {
    ...glass(true, suppressBlur),
    background: 'var(--cnv-chat-tint, var(--cnv-tint-deep))',
    backdropFilter: suppressBlur ? 'none' : 'blur(calc(var(--cnv-chat-frost, var(--cnv-frost)) * var(--cnv-frost-scale, 1))) saturate(var(--cnv-sat, 1.6))',
    WebkitBackdropFilter: suppressBlur ? 'none' : 'blur(calc(var(--cnv-chat-frost, var(--cnv-frost)) * var(--cnv-frost-scale, 1))) saturate(var(--cnv-sat, 1.6))',
    border: '1px solid var(--cnv-chat-edge, var(--cnv-edge))',
    color: 'var(--cnv-chat-ink, var(--cnv-ink))',
  } as CSSProperties;
}

/** Skiper-style edge fade for scrollable lists — content dissolves at the top
 *  and bottom edges instead of hard-cutting at the scroll bounds. Matches the
 *  o8.md panel / default chat's `cortex-scroll-fade-y`, inlined for the canvas
 *  (inline-styles only). Spread onto any scroll container. */
export const scrollFadeY = {
  WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)',
  maskImage: 'linear-gradient(to bottom, transparent 0, #000 24px, #000 calc(100% - 24px), transparent 100%)',
  WebkitMaskSize: '100% 100%',
  maskSize: '100% 100%',
  WebkitMaskRepeat: 'no-repeat',
  maskRepeat: 'no-repeat',
} as CSSProperties;

/** Rebinds the canvas ink/tint vocabulary INSIDE a chat card to the
 *  chat-scoped values — so when chats run their own tone (light fog on a
 *  dark canvas), every entry, dot, and hairline inside flips with them. */
export function chatVocabularyRebind(): CSSProperties {
  return {
    ['--cnv-ink' as string]: 'var(--cnv-chat-ink)',
    ['--cnv-ink-muted' as string]: 'var(--cnv-chat-ink-muted)',
    ['--cnv-edge' as string]: 'var(--cnv-chat-edge)',
    ['--cnv-tint' as string]: 'var(--cnv-chat-tint-soft)',
    ['--cnv-tint-deep' as string]: 'var(--cnv-chat-tint)',
  } as CSSProperties;
}

/** Floating menus/popovers that sit OVER text need a near-solid back —
 *  plain glass tint lets the content underneath bleed through the rows. */
export function glassPop(): CSSProperties {
  return {
    ...glass(true),
    // Layered: a near-opaque base under a pop-scoped tint. The pop
    // vocabulary contrasts with the UNIVERSAL text shade (set in
    // glass-settings) so menus never go same-on-same with the ink.
    background: 'linear-gradient(var(--cnv-pop-tint, var(--cnv-tint-deep)), var(--cnv-pop-tint, var(--cnv-tint-deep))), var(--cnv-pop-base, rgba(13, 16, 21, 0.88))',
  } as CSSProperties;
}

/** Mount-only card entrance vocabulary. Applied inline from page.tsx so the
 *  canvas keeps the no-class styling contract while still sharing keyframes. */
export const CARD_ENTRANCE = {
  enterMs: 200,
  borderMs: 350,
  reducedMs: 90,
  staggerMs: 60,
  sweepMs: 220,
  ease: 'cubic-bezier(0.22, 1, 0.36, 1)',
  keyframes: `
@keyframes cnv-card-enter {
  0% { opacity: 0; transform: scale(0.96); }
  72% { opacity: 1; transform: scale(1.012); }
  100% { opacity: 1; transform: none; }
}
@keyframes cnv-card-border-draw {
  0% { box-shadow: 0 0 0 1.5px var(--cnv-ink-muted), 0 0 18px -4px var(--cnv-ink); }
  100% { box-shadow: 0 0 0 0 var(--cnv-edge), 0 0 0 0 var(--cnv-edge); }
}
@keyframes cnv-card-fade-in {
  0% { opacity: 0; }
  100% { opacity: 1; }
}
`,
} as const;

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
/** xterm font size for canvas shells. The terminal card lives INSIDE the zoom
 *  layer (CSS `zoom`), so this px is scaled by the canvas zoom on screen —
 *  17 reads ~12px at the 0.7 ("100%") zoom, matching the o8.md body + the
 *  orchestrator dock instead of the old ~8px squint. Tune here. */
export const TERM_FONT_PX = 17;
/** Image cards resize aspect-locked from the corner grip. */
export const IMG_MIN_W = 120;
export const IMG_MAX_SPAWN_EDGE = 340;
/** DEV ONLY — title-bar veil slider for dialing the terminal glass; freeze
 *  the chosen value into the default and flip this off before graduating. */
export const DEV_TERM_GLASS_TUNER = true;

/** Current canvas zoom (CSS `zoom` on the card layer, stamped as
 *  --cnv-zoom). Pointer deltas arrive in VISUAL px — drag/resize handlers
 *  divide by this so cards track the cursor at any zoom step. */
export function canvasZoom(): number {
  if (typeof document === 'undefined') return 1;
  const raw = Number.parseFloat(document.documentElement.style.getPropertyValue('--cnv-zoom'));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

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
export interface OrcaThreadRow {
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
  /** images = dataURIs of attachments that rode this send — rendered as
   *  real thumbnails, not a "· 2 images attached" footnote. */
  | { role: 'user'; text: string; images?: string[] }
  /** kind 'tool' = a live activity cluster — text is the latest tool name
   *  while pending, count is how many calls it has absorbed. One row per
   *  work phase, not one per call. */
  | { role: 'status'; text: string; pending: boolean; kind?: 'tool'; count?: number }
  /** A turn artifact — the reference's rich result blocks. `kind` picks the
   *  shape; the extra fields carry the real data (file set + diff stats, a PR's
   *  number/state/checks, a captured screenshot src). `generic` keeps the old
   *  title+meta+open-arrow row. */
  | {
      role: 'result';
      kind?: 'generic' | 'files' | 'pr' | 'screenshot';
      title: string;
      meta?: string;
      body?: string;
      files?: string[];
      adds?: number;
      dels?: number;
      prNumber?: number;
      repo?: string;
      prState?: string;
      checks?: string;
      src?: string;
    }
  | { role: 'text'; text: string; live?: boolean }
  /** The model's reasoning stream — rendered as a timeline (stages split
   *  on paragraph breaks, REAL elapsed times). live grows in place.
   *  startedAt = epoch ms of the first delta; marks[i] = elapsed seconds
   *  when paragraph i closed. */
  | { role: 'thinking'; text: string; live?: boolean; startedAt?: number; marks?: number[] }
  /** Emitted once when a turn settles — carries the full assistant answer so
   *  the end-of-turn playback bar can speak "the entire thing he said." */
  | { role: 'playback'; text: string };

export type DockEntry = NewDockEntry & { id: number };
