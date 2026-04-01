/**
 * Pretext — zero-reflow text measurement & layout.
 *
 * Public API for the app. Components import from '@/lib/pretext'.
 *
 * Usage:
 *   import { usePretextHeight, measureHeight, FONTS } from '@/lib/pretext';
 */

// Core engine
export {
  FONTS,
  LINE_HEIGHTS,
  prepareText,
  prepareTextWithSegments,
  measureHeight,
  measureLayout,
  getLines,
  getNextLine,
  clearAllCaches,
  getCacheStats,
  type FontKey,
  type PreparedText,
  type PreparedTextWithSegments,
  type LayoutResult,
  type LayoutLinesResult,
  type LayoutLine,
  type LayoutCursor,
} from './engine';

// React hooks
export {
  usePretextHeight,
  usePretextLayout,
  usePretextLines,
  usePretextAutoLayout,
  useStreamingHeight,
  usePretextTruncation,
} from './hooks';
