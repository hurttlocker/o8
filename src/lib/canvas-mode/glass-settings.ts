'use client';

/**
 * canvas-mode/glass-settings — operator-tunable glass material for Canvas
 * mode (#1232). Two layers, persisted client-side and applied as CSS vars
 * so the Settings sliders and the /preview/canvas-glass test page share
 * one live value:
 *
 * The floating glass (cards, docks, rails):
 *   frost    — backdrop blur radius (px). How much the world behind a pane diffuses.
 *   tint     — dark tint alpha. 0 = clear glass, higher = the darker Apple/Siri material.
 *   ink      — text/icon white alpha. Legibility against whatever bleeds through.
 *   vibrance — backdrop saturation multiplier. How colourful the bleed-through reads.
 *
 * The background (the whole window, behind everything):
 *   material — the native NSVisualEffectMaterial id (discrete looks; the
 *              desktop diffusion level comes from macOS, not CSS). Applied
 *              by canvas surfaces via setCanvasMaterial — NOT a CSS var.
 *   veil     — a window-wide dark wash painted over the material (alpha).
 *              Continuous darkness control for the background itself.
 *
 * Vars (read them, never hardcode the material):
 *   --cnv-frost      blur(px) value, e.g. "26px"
 *   --cnv-tint       rgba surface tint
 *   --cnv-tint-deep  slightly darker tint for docks/inputs that need a step
 *   --cnv-ink        primary ink
 *   --cnv-ink-muted  secondary ink
 *   --cnv-edge       1px hairline for glass edges
 *   --cnv-sat        saturate() multiplier for the glass recipe
 *   --cnv-bg-veil    rgba window-wide wash (paint a full-inset layer with it)
 *   --cnv-dock-*     the docked orchestrator's own veil/tint/ink/edge/pop —
 *                    scoped on the dock surface so it tones apart from the
 *                    window without touching --cnv-bg-veil
 */

export interface CanvasGlassSettings {
  frost: number;
  tint: number;
  ink: number;
  vibrance: number;
  veil: number;
  material: string;
  /** Desktop blur behind the window (px) — native, continuous, the Liquid
   *  frost dial. Applied via setCanvasBackdropBlur, not a CSS var. */
  backdropFrost: number;
  /** Depth layer painted over the veil — paper grain / mesh / aurora.
   *  Ids match CANVAS_BACKDROPS; rendered by the canvas page, not a var. */
  backdrop: string;
  /** Floating orchestrator chat cards get their OWN material dial — they
   *  carry conversation text, so they run heavier than the ambient glass
   *  and the operator tunes them apart (--cnv-chat-frost / --cnv-chat-tint). */
  chatFrost: number;
  chatTint: number;
  /** Glass tone — 'dark' is the Siri slate, 'light' is the white fog the
   *  Symon settings page wears. Flips the whole --cnv-* vocabulary
   *  (tint goes white, ink goes dark). */
  tone: 'dark' | 'light';
  /** Chat cards can run their own tone — 'match' follows the canvas,
   *  or pin them light/dark so conversations stand apart. */
  chatTone: 'match' | 'dark' | 'light';
  /** The docked orchestrator (right-side panel) gets its OWN veil + tone so
   *  the operator can lighten it WITHOUT touching the window background
   *  (which --cnv-bg-veil drives). 'match' follows the canvas tone + the
   *  universal ink; pinning light/dark flips the dock's own vocabulary so a
   *  lightened dock keeps its text legible. */
  dockTone: 'match' | 'dark' | 'light';
  /** Dock veil alpha — the dark (or light, when toned) wash behind the
   *  docked orchestrator. Defaults to the window veil so the dock is
   *  unchanged until the operator dials it apart. */
  dockTint: number;
  /** UNIVERSAL text color — one slider for every pane (chat, terminal,
   *  o8.md, chrome, rail) so changing it moves ALL text in sync.
   *  0 = white, ~0.5 = the slate ink, 1 = black. Tone presets seed it
   *  (dark canvas → near-white text, light canvas → near-black). */
  textShade: number;
}

export const CANVAS_GLASS_TONES: ReadonlyArray<{ id: CanvasGlassSettings['tone']; label: string }> = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
];

export const CANVAS_CHAT_TONES: ReadonlyArray<{ id: CanvasGlassSettings['chatTone']; label: string }> = [
  { id: 'match', label: 'Match' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
];

export const CANVAS_DOCK_TONES: ReadonlyArray<{ id: CanvasGlassSettings['dockTone']; label: string }> = [
  { id: 'match', label: 'Match' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
];

/** The tone's natural text level — applied when the operator flips tone
 *  so panes and text never land same-on-same. The slider adjusts from there. */
export function defaultTextShadeForTone(tone: CanvasGlassSettings['tone']): number {
  return tone === 'light' ? 1 : 0.04;
}

// The default look is the operator's tuned LIGHT canvas (locked 2026-06-13):
// a true white wash (veil 1), clear glass (tint 0), black text (textShade 1)
// at 62% opacity on the Window material. Booting + Reset land here; flipping to
// Dark (Appearance) or picking a Look reshapes it. The personal "Custom" slot is
// independent (PERSONAL_KEY), so making this the default never clobbers it.
export const CANVAS_GLASS_DEFAULTS: CanvasGlassSettings = {
  frost: 64,
  tint: 0,
  ink: 0.62,
  vibrance: 2.2,
  veil: 1,
  material: 'window',
  backdropFrost: 0,
  backdrop: 'none',
  chatFrost: 27,
  chatTint: 0.62,
  tone: 'light',
  chatTone: 'light',
  dockTone: 'light',
  dockTint: 0,
  textShade: 1,
};

/**
 * The see-through depth layers — the operator-picked set (gallery
 * browse happened 2026-06-12; these survived). Trails + Dots are
 * custom 2D-canvas pieces, the rest are hand-tuned Paper Shaders. Ids
 * match the CanvasBackdropLayer switch in preview/canvas-glass/backdrops.tsx.
 */
export const CANVAS_BACKDROPS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'trails', label: 'Trails' },
  { id: 'dots', label: 'Dots' },
  { id: 'paper', label: 'Paper' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'warp', label: 'Warp' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'radial', label: 'Radial' },
  { id: 'ember', label: 'Ember' },
];

export const CANVAS_GLASS_RANGES = {
  frost: { min: 0, max: 64, step: 1 },
  tint: { min: 0, max: 0.85, step: 0.01 },
  ink: { min: 0.55, max: 1, step: 0.01 },
  vibrance: { min: 1, max: 2.2, step: 0.05 },
  veil: { min: 0, max: 1, step: 0.01 },
  backdropFrost: { min: 0, max: 64, step: 1 },
  chatFrost: { min: 0, max: 100, step: 1 },
  chatTint: { min: 0, max: 0.92, step: 0.01 },
  dockTint: { min: 0, max: 0.92, step: 0.01 },
  textShade: { min: 0, max: 1, step: 0.01 },
} as const;

/**
 * The native background materials a canvas surface can run on — each is a
 * distinct macOS look (Popover = the clear Symon-settings glass, HUD = the
 * dark chrome default, the rest sit between). Ids match the Rust
 * set_canvas_material command.
 */
export const CANVAS_GLASS_MATERIALS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'none', label: 'Liquid' },
  { id: 'popover', label: 'Popover' },
  { id: 'menu', label: 'Menu' },
  { id: 'sidebar', label: 'Sidebar' },
  { id: 'sheet', label: 'Sheet' },
  { id: 'window', label: 'Window' },
  { id: 'under-window', label: 'Under' },
  { id: 'fullscreen', label: 'Full' },
  { id: 'hud', label: 'HUD' },
];

/**
 * One-click looks — the "theme switcher" for the glass. Each is a full
 * combo across both layers; the sliders fine-tune from wherever a preset
 * lands. Clear = the desktop reads through (the Symon-settings look);
 * Siri = the dark Apple reference; Frost = heavy private glass.
 */
export const CANVAS_GLASS_PRESETS: ReadonlyArray<{ id: string; label: string; values: CanvasGlassSettings }> = [
  // o8 — the operator's signature look, shipped for everyone (the former "Mine").
  // Dark HUD glass over the ember backdrop; the personal "Custom" slot stays free.
  { id: 'o8', label: 'o8', values: { frost: 3, tint: 0, ink: 1, vibrance: 2.2, veil: 0.3, material: 'hud', backdropFrost: 0, backdrop: 'ember', chatFrost: 50, chatTint: 0, tone: 'dark', chatTone: 'match', dockTone: 'dark', dockTint: 0.92, textShade: 0.04 } },
  // Slate — the dark Siri reference; the default look.
  { id: 'siri', label: 'Slate', values: { frost: 26, tint: 0.42, ink: 0.92, vibrance: 1.6, veil: 0.3, material: 'popover', backdropFrost: 0, backdrop: 'none', chatFrost: 34, chatTint: 0.6, tone: 'dark', chatTone: 'match', dockTone: 'match', dockTint: 0.3, textShade: 0.04 } },
  // Paper — the white canvas: light wash, dark ink, light glass throughout.
  { id: 'paper', label: 'Paper', values: { frost: 22, tint: 0.5, ink: 0.95, vibrance: 1.4, veil: 0.9, material: 'window', backdropFrost: 0, backdrop: 'none', chatFrost: 30, chatTint: 0.62, tone: 'light', chatTone: 'match', dockTone: 'match', dockTint: 0.9, textShade: 0.86 } },
  { id: 'clear', label: 'Clear', values: { frost: 10, tint: 0.16, ink: 0.96, vibrance: 1.5, veil: 0, material: 'none', backdropFrost: 12, backdrop: 'none', chatFrost: 20, chatTint: 0.38, tone: 'dark', chatTone: 'match', dockTone: 'match', dockTint: 0, textShade: 0.04 } },
  { id: 'frost', label: 'Frost', values: { frost: 48, tint: 0.62, ink: 0.96, vibrance: 1.7, veil: 0.5, material: 'sidebar', backdropFrost: 0, backdrop: 'none', chatFrost: 54, chatTint: 0.78, tone: 'dark', chatTone: 'match', dockTone: 'match', dockTint: 0.5, textShade: 0.04 } },
  // Glass — the locked ALL GLASS recipe from the IDE side (Q 2026-07-17),
  // translated to canvas vocabulary: FullScreenUI material (the bake-off
  // winner that melts the desktop into structureless color), a mid veil
  // standing in for the IDE's 0.78→0.06 gradient, minimal card tint so the
  // one-material feel carries, near-white ink.
  { id: 'glass', label: 'Glass', values: { frost: 18, tint: 0.1, ink: 0.96, vibrance: 1.8, veil: 0.45, material: 'fullscreen', backdropFrost: 0, backdrop: 'none', chatFrost: 30, chatTint: 0.5, tone: 'dark', chatTone: 'match', dockTone: 'match', dockTint: 0.45, textShade: 0.04 } },
];

/**
 * The baseline appearance shortcuts (operator 2026-07-06, extended
 * 2026-07-17). All looks and controls are open in the open build; this compact
 * mapping remains useful for saved settings and preserves a future cosmetic
 * policy seam without making today's plan a cosmetic gate.
 */
export type CanvasFreeLookId = 'light' | 'dark' | 'glass';

export const CANVAS_FREE_LOOKS: ReadonlyArray<{ id: CanvasFreeLookId; label: string }> = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'glass', label: 'Glass' },
];

export function canvasFreeLook(look: CanvasFreeLookId): CanvasGlassSettings {
  if (look === 'glass') {
    return { ...CANVAS_GLASS_PRESETS.find((p) => p.id === 'glass')!.values };
  }
  const paper = CANVAS_GLASS_PRESETS.find((p) => p.id === 'paper')!.values;
  // veil 1 = fully opaque washes, the exact IDE surface colors.
  if (look === 'light') return { ...paper, veil: 1 };
  // Free Dark matches the IDE's dark-solid graphite (Q 2026-07-17: the three
  // shipping looks mean the SAME thing on both surfaces) — near-opaque dark
  // wash, not the old translucent 0.3 veil that read as a second glass mode.
  return {
    ...paper,
    tone: 'dark',
    textShade: defaultTextShadeForTone('dark'),
    veil: 1,
    tint: 0.5,
    chatTint: 0.55,
    dockTint: 0.95,
  };
}

/** Which baseline appearance a stored settings blob corresponds to. Glass is
 *  tone-dark, so material is the marker. */
export function canvasFreeLookIdFor(settings: Pick<CanvasGlassSettings, 'tone' | 'material'>): CanvasFreeLookId {
  if (settings.material === 'fullscreen') return 'glass';
  return settings.tone === 'light' ? 'light' : 'dark';
}

const STORAGE_KEY = 'o8:canvas-glass';
const PERSONAL_KEY = 'o8:canvas-glass-personal';
export const CANVAS_GLASS_CHANGED_EVENT = 'o8:canvas-glass-changed';

/**
 * Liquid (no material) with zero backdrop frost is indistinguishable from
 * no window at all — operator-locked floor of ~10% of the dial so the
 * glass always reads as glass. Other materials carry their own blur, so
 * the floor only applies to 'none'.
 */
export const LIQUID_MIN_BACKDROP_FROST = 6;

function normalizeForMaterial(settings: CanvasGlassSettings): CanvasGlassSettings {
  if (settings.material === 'none' && settings.backdropFrost < LIQUID_MIN_BACKDROP_FROST) {
    return { ...settings, backdropFrost: LIQUID_MIN_BACKDROP_FROST };
  }
  return settings;
}

/** The operator's saved look — the "Custom" preset. Null until saved once. */
export function readPersonalDefault(): CanvasGlassSettings | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PERSONAL_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    // Run it through the same per-field validation as the live settings.
    const candidate = parsed as Partial<CanvasGlassSettings>;
    return {
      frost: readNumber(candidate.frost, CANVAS_GLASS_RANGES.frost, CANVAS_GLASS_DEFAULTS.frost),
      tint: readNumber(candidate.tint, CANVAS_GLASS_RANGES.tint, CANVAS_GLASS_DEFAULTS.tint),
      ink: readNumber(candidate.ink, CANVAS_GLASS_RANGES.ink, CANVAS_GLASS_DEFAULTS.ink),
      vibrance: readNumber(candidate.vibrance, CANVAS_GLASS_RANGES.vibrance, CANVAS_GLASS_DEFAULTS.vibrance),
      veil: readNumber(candidate.veil, CANVAS_GLASS_RANGES.veil, CANVAS_GLASS_DEFAULTS.veil),
      material: typeof candidate.material === 'string' && CANVAS_GLASS_MATERIALS.some((m) => m.id === candidate.material)
        ? candidate.material
        : CANVAS_GLASS_DEFAULTS.material,
      backdropFrost: readNumber(candidate.backdropFrost, CANVAS_GLASS_RANGES.backdropFrost, CANVAS_GLASS_DEFAULTS.backdropFrost),
      backdrop: typeof candidate.backdrop === 'string' && CANVAS_BACKDROPS.some((b) => b.id === candidate.backdrop)
        ? candidate.backdrop
        : CANVAS_GLASS_DEFAULTS.backdrop,
      chatFrost: readNumber(candidate.chatFrost, CANVAS_GLASS_RANGES.chatFrost, CANVAS_GLASS_DEFAULTS.chatFrost),
      chatTint: readNumber(candidate.chatTint, CANVAS_GLASS_RANGES.chatTint, CANVAS_GLASS_DEFAULTS.chatTint),
      tone: candidate.tone === 'light' ? 'light' : 'dark',
      chatTone: candidate.chatTone === 'light' || candidate.chatTone === 'dark' ? candidate.chatTone : 'match',
      dockTone: candidate.dockTone === 'light' || candidate.dockTone === 'dark' ? candidate.dockTone : 'match',
      // Absent dockTint inherits the window veil — the dock looks unchanged
      // until the operator dials it apart.
      dockTint: readNumber(candidate.dockTint, CANVAS_GLASS_RANGES.dockTint, readNumber(candidate.veil, CANVAS_GLASS_RANGES.veil, CANVAS_GLASS_DEFAULTS.veil)),
      textShade: readNumber(candidate.textShade, CANVAS_GLASS_RANGES.textShade, defaultTextShadeForTone(candidate.tone === 'light' ? 'light' : 'dark')),
    };
  } catch {
    return null;
  }
}

export function savePersonalDefault(settings: CanvasGlassSettings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PERSONAL_KEY, JSON.stringify(settings));
  } catch {
    // non-critical
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readNumber(candidate: unknown, range: { min: number; max: number }, fallback: number): number {
  return typeof candidate === 'number' && Number.isFinite(candidate)
    ? clamp(candidate, range.min, range.max)
    : fallback;
}

export function readCanvasGlassSettings(): CanvasGlassSettings {
  if (typeof window === 'undefined') return { ...CANVAS_GLASS_DEFAULTS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...CANVAS_GLASS_DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...CANVAS_GLASS_DEFAULTS };
    const candidate = parsed as Partial<CanvasGlassSettings>;
    return normalizeForMaterial({
      frost: readNumber(candidate.frost, CANVAS_GLASS_RANGES.frost, CANVAS_GLASS_DEFAULTS.frost),
      tint: readNumber(candidate.tint, CANVAS_GLASS_RANGES.tint, CANVAS_GLASS_DEFAULTS.tint),
      ink: readNumber(candidate.ink, CANVAS_GLASS_RANGES.ink, CANVAS_GLASS_DEFAULTS.ink),
      vibrance: readNumber(candidate.vibrance, CANVAS_GLASS_RANGES.vibrance, CANVAS_GLASS_DEFAULTS.vibrance),
      veil: readNumber(candidate.veil, CANVAS_GLASS_RANGES.veil, CANVAS_GLASS_DEFAULTS.veil),
      material: typeof candidate.material === 'string' && CANVAS_GLASS_MATERIALS.some((m) => m.id === candidate.material)
        ? candidate.material
        : CANVAS_GLASS_DEFAULTS.material,
      backdropFrost: readNumber(candidate.backdropFrost, CANVAS_GLASS_RANGES.backdropFrost, CANVAS_GLASS_DEFAULTS.backdropFrost),
      backdrop: typeof candidate.backdrop === 'string' && CANVAS_BACKDROPS.some((b) => b.id === candidate.backdrop)
        ? candidate.backdrop
        : CANVAS_GLASS_DEFAULTS.backdrop,
      chatFrost: readNumber(candidate.chatFrost, CANVAS_GLASS_RANGES.chatFrost, CANVAS_GLASS_DEFAULTS.chatFrost),
      chatTint: readNumber(candidate.chatTint, CANVAS_GLASS_RANGES.chatTint, CANVAS_GLASS_DEFAULTS.chatTint),
      tone: candidate.tone === 'light' ? 'light' : 'dark',
      chatTone: candidate.chatTone === 'light' || candidate.chatTone === 'dark' ? candidate.chatTone : 'match',
      dockTone: candidate.dockTone === 'light' || candidate.dockTone === 'dark' ? candidate.dockTone : 'match',
      // Absent dockTint inherits the window veil — the dock looks unchanged
      // until the operator dials it apart.
      dockTint: readNumber(candidate.dockTint, CANVAS_GLASS_RANGES.dockTint, readNumber(candidate.veil, CANVAS_GLASS_RANGES.veil, CANVAS_GLASS_DEFAULTS.veil)),
      textShade: readNumber(candidate.textShade, CANVAS_GLASS_RANGES.textShade, defaultTextShadeForTone(candidate.tone === 'light' ? 'light' : 'dark')),
    });
  } catch {
    return { ...CANVAS_GLASS_DEFAULTS };
  }
}

/** Persist + apply. Returns the normalized settings (the Liquid frost
 *  floor may bump backdropFrost) — callers should adopt the return. */
export function writeCanvasGlassSettings(settings: CanvasGlassSettings): CanvasGlassSettings {
  const normalized = normalizeForMaterial(settings);
  if (typeof window === 'undefined') return normalized;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // non-critical — the look just won't survive reload
  }
  applyCanvasGlassSettings(normalized);
  window.dispatchEvent(new CustomEvent(CANVAS_GLASS_CHANGED_EVENT, { detail: normalized }));
  return normalized;
}

/** Per-tone glass PANE recipe — dark is the Siri slate, light is the
 *  Symon-settings white fog. Text color is NOT tone's business anymore:
 *  the universal textShade slider owns it. */
function toneVocabulary(tone: CanvasGlassSettings['tone'], tint: number) {
  if (tone === 'light') {
    return {
      tint: `rgba(252, 253, 255, ${tint.toFixed(2)})`,
      tintDeep: `rgba(255, 255, 255, ${Math.min(0.95, tint + 0.16).toFixed(2)})`,
      edge: `rgba(12, 16, 24, ${(0.1 + tint * 0.08).toFixed(2)})`,
      // Neutral GREY frost for media rims/headers — the near-white tints above
      // vanish on a white/paper canvas, so photo & video cards use this so the
      // outline + header read as grey-on-white (fixed alpha, slider-independent).
      mediaRim: 'rgba(108, 116, 130, 0.20)',
      popBase: 'rgba(250, 251, 253, 0.9)',
    };
  }
  return {
    tint: `rgba(9, 11, 16, ${tint.toFixed(2)})`,
    tintDeep: `rgba(7, 9, 13, ${Math.min(0.92, tint + 0.16).toFixed(2)})`,
    edge: `rgba(255, 255, 255, ${(0.1 + tint * 0.1).toFixed(2)})`,
    // On the dark canvas a light frost already reads — keep media rims light.
    mediaRim: 'rgba(255, 255, 255, 0.10)',
    popBase: 'rgba(13, 16, 21, 0.88)',
  };
}

/** The universal text sweep — white → slate ink → black, one dial. */
function shadeRgb(shade: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, shade));
  const anchors: Array<[number, [number, number, number]]> = [
    [0, [255, 255, 255]],
    [0.5, [148, 158, 172]],
    [1, [6, 8, 12]],
  ];
  for (let i = 0; i < anchors.length - 1; i++) {
    const [from, fromRgb] = anchors[i];
    const [to, toRgb] = anchors[i + 1];
    if (clamped <= to) {
      const t = (clamped - from) / (to - from);
      return [
        Math.round(fromRgb[0] + (toRgb[0] - fromRgb[0]) * t),
        Math.round(fromRgb[1] + (toRgb[1] - fromRgb[1]) * t),
        Math.round(fromRgb[2] + (toRgb[2] - fromRgb[2]) * t),
      ];
    }
  }
  return anchors[anchors.length - 1][1];
}

function inkFromShade(shade: number, alpha: number) {
  const [r, g, b] = shadeRgb(shade);
  return {
    ink: `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`,
    inkMuted: `rgba(${r}, ${g}, ${b}, ${(alpha * 0.62).toFixed(2)})`,
  };
}

/** Stamp the material onto :root so any surface can consume it. */
export function applyCanvasGlassSettings(settings?: CanvasGlassSettings): void {
  if (typeof document === 'undefined') return;
  // Merge over defaults so a caller passing a settings object that predates a
  // newer field (e.g. Fast-Refresh-preserved React state from before dockTint
  // existed) can never throw here and crash the canvas mount.
  const value = { ...CANVAS_GLASS_DEFAULTS, ...(settings ?? readCanvasGlassSettings()) };
  const root = document.documentElement;
  const base = toneVocabulary(value.tone, value.tint);
  // ONE text color for the whole canvas — the universal slider drives
  // every pane's ink so a single move keeps chat, terminal, o8.md, and
  // chrome in sync.
  const text = inkFromShade(value.textShade, value.ink);
  root.style.setProperty('--cnv-frost', `${Math.round(value.frost)}px`);
  root.style.setProperty('--cnv-tint', base.tint);
  root.style.setProperty('--cnv-tint-deep', base.tintDeep);
  root.style.setProperty('--cnv-ink', text.ink);
  root.style.setProperty('--cnv-ink-muted', text.inkMuted);
  root.style.setProperty('--cnv-edge', base.edge);
  root.style.setProperty('--cnv-media-rim', base.mediaRim);
  // Popovers must CONTRAST with the universal text, not follow the pane
  // tone — light text gets the dark near-solid base (the composer-pill
  // family), dark text gets the white one. Menus stay readable at any
  // slider position.
  const popTone = value.textShade < 0.5 ? 'dark' : 'light';
  const pop = toneVocabulary(popTone, Math.min(0.92, value.tint + 0.16));
  root.style.setProperty('--cnv-pop-tint', pop.tintDeep);
  root.style.setProperty('--cnv-pop-base', pop.popBase);
  root.style.setProperty('--cnv-sat', `${value.vibrance.toFixed(2)}`);
  // Background follows the appearance — dark slate or light paper — and the
  // dot grid flips so it reads on either. THIS is what makes Light a true
  // white canvas, not just light panes floating over a dark desktop.
  const bgLight = value.tone === 'light';
  // Standard surface colors match the IDE side exactly (Q 2026-07-17):
  // light wash = the cream paper #F4F2ED, dark wash = the graphite #1c1c1c.
  // Every look rides the same pair, so the two surfaces read as one family.
  root.style.setProperty('--cnv-bg-veil', `rgba(${bgLight ? '244, 242, 237' : '28, 28, 28'}, ${value.veil.toFixed(2)})`);
  root.style.setProperty('--cnv-bg-dot', bgLight ? 'rgba(12, 15, 22, 0.05)' : 'rgba(255, 255, 255, 0.055)');
  // Chat cards: their own frost + tint amounts, optionally their own pane
  // tone — but the TEXT is the universal shade, same as everything else.
  const chatTone = value.chatTone === 'match' ? value.tone : value.chatTone;
  const chat = toneVocabulary(chatTone, value.chatTint);
  root.style.setProperty('--cnv-chat-frost', `${Math.round(value.chatFrost)}px`);
  root.style.setProperty('--cnv-chat-tint', chat.tint);
  root.style.setProperty('--cnv-chat-tint-deep', chat.tintDeep);
  root.style.setProperty('--cnv-chat-tint-soft', toneVocabulary(chatTone, Math.max(0, value.chatTint - 0.2)).tint);
  root.style.setProperty('--cnv-chat-ink', text.ink);
  root.style.setProperty('--cnv-chat-ink-muted', text.inkMuted);
  root.style.setProperty('--cnv-chat-edge', chat.edge);
  // The docked orchestrator: its own veil, scoped to the dock so lightening
  // it never touches the window background. The dock has ALWAYS faded in the
  // fixed dark slate (old --cnv-bg-veil was rgba(7,9,13,·) regardless of the
  // canvas tone), so 'match' keeps that exact wash + the universal everything
  // — pixel-identical to before this dial. 'dark' is match with a pinned
  // near-white ink (legible at any textShade); 'light' switches the veil to a
  // white fog and pins the ink dark so a lightened dock still reads.
  const dockToneResolved = value.dockTone === 'match' ? value.tone : value.dockTone;
  const dockVeilLight = dockToneResolved === 'light';
  root.style.setProperty('--cnv-dock-veil', `rgba(${dockVeilLight ? '252, 253, 255' : '7, 9, 13'}, ${value.dockTint.toFixed(2)})`);
  if (value.dockTone === 'match') {
    // Inherit the global vocabulary — the dock surface override is a no-op, so
    // the dock follows the appearance (light canvas → light dock, dark ink).
    root.style.setProperty('--cnv-dock-tint', base.tint);
    root.style.setProperty('--cnv-dock-tint-deep', base.tintDeep);
    root.style.setProperty('--cnv-dock-edge', base.edge);
    root.style.setProperty('--cnv-dock-ink', text.ink);
    root.style.setProperty('--cnv-dock-ink-muted', text.inkMuted);
    root.style.setProperty('--cnv-dock-pop-tint', pop.tintDeep);
    root.style.setProperty('--cnv-dock-pop-base', pop.popBase);
  } else {
    const dockVocab = toneVocabulary(dockToneResolved, value.tint);
    root.style.setProperty('--cnv-dock-tint', dockVocab.tint);
    root.style.setProperty('--cnv-dock-tint-deep', dockVocab.tintDeep);
    root.style.setProperty('--cnv-dock-edge', dockVocab.edge);
    const dockText = inkFromShade(dockVeilLight ? 0.9 : 0.06, value.ink);
    root.style.setProperty('--cnv-dock-ink', dockText.ink);
    root.style.setProperty('--cnv-dock-ink-muted', dockText.inkMuted);
    // Lane-menu popover contrasts the dock ink: light dock → light menu, dark dock → dark menu.
    const dockPop = toneVocabulary(dockVeilLight ? 'light' : 'dark', Math.min(0.92, value.tint + 0.16));
    root.style.setProperty('--cnv-dock-pop-tint', dockPop.tintDeep);
    root.style.setProperty('--cnv-dock-pop-base', dockPop.popBase);
  }
}
