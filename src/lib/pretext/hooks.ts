/**
 * Pretext React Hooks — zero-reflow text measurement for components.
 *
 * All hooks return stable values and handle resize/memoization automatically.
 * They never touch the DOM layout engine — pure math after initial Canvas measurement.
 */

'use client';

import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import {
  measureHeight,
  measureLayout,
  getLines,
  LINE_HEIGHTS,
  type FontKey,
  type LayoutResult,
  type LayoutLinesResult,
} from './engine';

/**
 * Measure text height without triggering DOM reflow.
 * Returns height in pixels. Recalculates only when text, font, or width changes.
 */
export function usePretextHeight(
  text: string,
  font: FontKey,
  maxWidth: number,
  lineHeight?: number,
  whiteSpace?: 'normal' | 'pre-wrap',
): number {
  return useMemo(
    () => measureHeight(text, font, maxWidth, lineHeight, whiteSpace),
    [text, font, maxWidth, lineHeight, whiteSpace],
  );
}

/**
 * Full layout result (lineCount + height).
 */
export function usePretextLayout(
  text: string,
  font: FontKey,
  maxWidth: number,
  lineHeight?: number,
  whiteSpace?: 'normal' | 'pre-wrap',
): LayoutResult {
  return useMemo(
    () => measureLayout(text, font, maxWidth, lineHeight, whiteSpace),
    [text, font, maxWidth, lineHeight, whiteSpace],
  );
}

/**
 * Per-line layout data. Use when you need to render individual lines
 * or implement virtual scrolling.
 */
export function usePretextLines(
  text: string,
  font: FontKey,
  maxWidth: number,
  lineHeight?: number,
  whiteSpace?: 'normal' | 'pre-wrap',
): LayoutLinesResult {
  return useMemo(
    () => getLines(text, font, maxWidth, lineHeight, whiteSpace),
    [text, font, maxWidth, lineHeight, whiteSpace],
  );
}

/**
 * Observe an element's width and auto-measure text height.
 * Returns { width, height } — both update on resize without DOM reflow.
 *
 * Uses ResizeObserver for width tracking, Pretext for height calculation.
 */
export function usePretextAutoLayout(
  text: string,
  font: FontKey,
  lineHeight?: number,
  whiteSpace?: 'normal' | 'pre-wrap',
): {
  ref: (node: HTMLElement | null) => void;
  width: number;
  height: number;
  lineCount: number;
} {
  const [width, setWidth] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const nodeRef = useRef<HTMLElement | null>(null);

  const ref = useCallback((node: HTMLElement | null) => {
    // Cleanup previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    nodeRef.current = node;

    if (node) {
      // Read initial width (one-time layout read, unavoidable)
      setWidth(node.clientWidth);

      observerRef.current = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
          setWidth(w);
        }
      });
      observerRef.current.observe(node);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, []);

  const result = useMemo(
    () => (width > 0 ? measureLayout(text, font, width, lineHeight, whiteSpace) : { lineCount: 0, height: 0 }),
    [text, font, width, lineHeight, whiteSpace],
  );

  return { ref, width, height: result.height, lineCount: result.lineCount };
}

/**
 * Streaming text height — optimized for rapidly changing text (token streaming).
 * Debounces prepare() calls but layout() runs every update (it's pure math, <0.1ms).
 *
 * Returns current height that updates as text grows.
 */
export function useStreamingHeight(
  text: string,
  font: FontKey,
  maxWidth: number,
  lineHeight?: number,
  whiteSpace?: 'normal' | 'pre-wrap',
): number {
  const lh = lineHeight ?? LINE_HEIGHTS[font];
  // For streaming, we always recalculate — layout() is pure math and costs ~0.09ms
  return useMemo(
    () => {
      if (!text || maxWidth <= 0) return 0;
      return measureHeight(text, font, maxWidth, lh, whiteSpace);
    },
    [text, font, maxWidth, lh, whiteSpace],
  );
}

/**
 * Smart truncation — calculate where to truncate text without DOM measurement.
 * Returns the truncated string with ellipsis if it exceeds maxLines.
 */
export function usePretextTruncation(
  text: string,
  font: FontKey,
  maxWidth: number,
  maxLines: number,
  lineHeight?: number,
): { truncated: string; isTruncated: boolean } {
  return useMemo(() => {
    if (!text || maxWidth <= 0 || maxLines <= 0) return { truncated: text, isTruncated: false };

    const result = getLines(text, font, maxWidth, lineHeight);
    if (result.lines.length <= maxLines) return { truncated: text, isTruncated: false };

    // Build the full truncated string from all visible lines
    const visibleText = result.lines
      .slice(0, maxLines)
      .map(l => l.text)
      .join('')
      .trimEnd();

    return { truncated: visibleText + '\u2026', isTruncated: true };
  }, [text, font, maxWidth, maxLines, lineHeight]);
}
