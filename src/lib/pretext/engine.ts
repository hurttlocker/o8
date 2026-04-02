/**
 * Pretext Engine — centralized text measurement & layout utilities.
 *
 * All Pretext usage in the app goes through this module. Components never
 * import from '@chenglou/pretext' directly. This gives us:
 *   - Centralized font config matching our design system
 *   - Bounded LRU cache (no memory leaks)
 *   - Single place to tune or swap the library
 *
 * IMPORTANT: Pretext requires Canvas API (browser-only). The prepare() call
 * will throw on the server. All public functions guard against SSR and return
 * zero/empty results when called server-side. Hooks are 'use client' only.
 */

import {
  prepare,
  prepareWithSegments,
  layout,
  layoutWithLines,
  layoutNextLine,
  clearCache as clearPretextInternalCache,
  type PreparedText,
  type PreparedTextWithSegments,
  type LayoutResult,
  type LayoutLinesResult,
  type LayoutLine,
  type LayoutCursor,
  type PrepareOptions,
} from '@chenglou/pretext';

const isBrowser = typeof window !== 'undefined';

// ── Font Constants ──────────────────────────────────────────────────────
// Must match the exact CSS font shorthand used in components.
// Canvas measureText() uses the same font engine as DOM, so these must
// be identical to what components render with.

export const FONTS = {
  /** Body text — chat messages, descriptions, general UI */
  body: '14px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
  /** Compact body — markdown body in compact mode */
  bodyCompact: '13.44px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
  /** Small text — timestamps, labels, secondary info */
  small: '12px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
  /** Tiny text — badges, meta */
  tiny: '11px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
  /** Monospace — code blocks, diffs, terminal output */
  mono: '12px "SF Mono", Menlo, ui-monospace, monospace',
  /** Monospace block — expanded mobile code blocks */
  monoBlock: '13px "SF Mono", Menlo, ui-monospace, monospace',
  /** Monospace small — inline code, file paths */
  monoSmall: '11px "SF Mono", Menlo, ui-monospace, monospace',
  /** Heading — card titles, section headers */
  heading: '16px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif',
} as const;

export type FontKey = keyof typeof FONTS;

/** Default line heights per font — matches component inline styles */
export const LINE_HEIGHTS: Record<FontKey, number> = {
  body: 1.6,        // LLMChat message body
  bodyCompact: 1.6, // compact markdown
  small: 1.45,      // common in AgentPanel, RepoRegistry
  tiny: 1.4,
  mono: 1.5,        // code blocks, diffs
  monoBlock: 1.5,
  monoSmall: 1.45,
  heading: 1.3,
};

// ── LRU Cache ───────────────────────────────────────────────────────────

const MAX_CACHE_SIZE = 512;

interface CacheEntry<T> {
  value: T;
  key: string;
}

class LRUCache<T> {
  private map = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= MAX_CACHE_SIZE) {
      // Evict oldest (first entry)
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, { value, key });
  }

  get size() { return this.map.size; }

  clear(): void {
    this.map.clear();
  }
}

const prepareCache = new LRUCache<PreparedText>();
const prepareSegCache = new LRUCache<PreparedTextWithSegments>();

function cacheKey(text: string, font: FontKey, whiteSpace?: 'normal' | 'pre-wrap'): string {
  return `${font}\0${whiteSpace ?? 'normal'}\0${text}`;
}

// ── Core API ────────────────────────────────────────────────────────────

/**
 * Prepare text for measurement (cached). Use this for simple height calculations
 * where you don't need per-line data.
 * Returns null on the server (no Canvas API).
 */
export function prepareText(
  text: string,
  font: FontKey,
  whiteSpace?: 'normal' | 'pre-wrap',
): PreparedText | null {
  if (!isBrowser) return null;
  const key = cacheKey(text, font, whiteSpace);
  const cached = prepareCache.get(key);
  if (cached) return cached;

  const opts: PrepareOptions | undefined = whiteSpace ? { whiteSpace } : undefined;
  const prepared = prepare(text, FONTS[font], opts);
  prepareCache.set(key, prepared);
  return prepared;
}

/**
 * Prepare text with segment data (cached). Use this when you need per-line
 * layout (layoutWithLines, layoutNextLine, walkLineRanges).
 * Returns null on the server (no Canvas API).
 */
export function prepareTextWithSegments(
  text: string,
  font: FontKey,
  whiteSpace?: 'normal' | 'pre-wrap',
): PreparedTextWithSegments | null {
  if (!isBrowser) return null;
  const key = cacheKey(text, font, whiteSpace);
  const cached = prepareSegCache.get(key);
  if (cached) return cached;

  const opts: PrepareOptions | undefined = whiteSpace ? { whiteSpace } : undefined;
  const prepared = prepareWithSegments(text, FONTS[font], opts);
  prepareSegCache.set(key, prepared);
  return prepared;
}

/**
 * Measure text height for a given container width. The most common operation —
 * returns just the height in pixels. Pure math after initial prepare().
 * Returns 0 on the server.
 */
export function measureHeight(
  text: string,
  font: FontKey,
  maxWidth: number,
  lineHeight?: number,
  whiteSpace?: 'normal' | 'pre-wrap',
): number {
  if (!text) return 0;
  const prepared = prepareText(text, font, whiteSpace);
  if (!prepared) return 0;
  const lh = lineHeight ?? LINE_HEIGHTS[font];
  const result = layout(prepared, maxWidth, lh);
  return result.height;
}

/**
 * Full layout result — lineCount + height. Pure math.
 * Returns zero result on the server.
 */
export function measureLayout(
  text: string,
  font: FontKey,
  maxWidth: number,
  lineHeight?: number,
  whiteSpace?: 'normal' | 'pre-wrap',
): LayoutResult {
  if (!text) return { lineCount: 0, height: 0 };
  const prepared = prepareText(text, font, whiteSpace);
  if (!prepared) return { lineCount: 0, height: 0 };
  const lh = lineHeight ?? LINE_HEIGHTS[font];
  return layout(prepared, maxWidth, lh);
}

/**
 * Get per-line layout data — text content, width, start/end cursors.
 * Use when you need to render or iterate individual lines.
 * Returns empty result on the server.
 */
export function getLines(
  text: string,
  font: FontKey,
  maxWidth: number,
  lineHeight?: number,
  whiteSpace?: 'normal' | 'pre-wrap',
): LayoutLinesResult {
  if (!text) return { lineCount: 0, height: 0, lines: [] };
  const prepared = prepareTextWithSegments(text, font, whiteSpace);
  if (!prepared) return { lineCount: 0, height: 0, lines: [] };
  const lh = lineHeight ?? LINE_HEIGHTS[font];
  return layoutWithLines(prepared, maxWidth, lh);
}

/**
 * Iterator-style per-line layout. Use for variable-width layouts
 * (e.g. text wrapping around obstacles).
 */
export function getNextLine(
  prepared: PreparedTextWithSegments,
  start: LayoutCursor,
  maxWidth: number,
): LayoutLine | null {
  return layoutNextLine(prepared, start, maxWidth);
}

/**
 * Clear all caches — call when fonts change or on memory pressure.
 */
export function clearAllCaches(): void {
  prepareCache.clear();
  prepareSegCache.clear();
  clearPretextInternalCache();
}

/**
 * Get cache stats for debugging.
 */
export function getCacheStats() {
  return {
    prepareEntries: prepareCache.size,
    prepareSegEntries: prepareSegCache.size,
    maxSize: MAX_CACHE_SIZE,
  };
}

// ── Re-exports ──────────────────────────────────────────────────────────
// Types consumers may need

export type {
  PreparedText,
  PreparedTextWithSegments,
  LayoutResult,
  LayoutLinesResult,
  LayoutLine,
  LayoutCursor,
};
