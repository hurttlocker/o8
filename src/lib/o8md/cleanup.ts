import { extractRoughdraftReviewIndex, type RfmReviewItem } from './rfm';

export interface RoughdraftAnnotationCleanupResult {
  content: string;
  removedAnnotations: number;
}

const EMPTY_MARKER_HINT = /\{==\s*==\}|\{~~\s*~>|\{--\s*--\}|\{\+\+\s*\+\+\}/;

function empty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length === 0;
}

function findHighlightStart(markdown: string, item: RfmReviewItem): number | null {
  if (item.anchorText === undefined) return null;
  const from = item.offset - item.anchorText.length - 6;
  if (from < 0) return null;
  const closeFrom = from + 3 + item.anchorText.length;
  if (!markdown.startsWith('{==', from)) return null;
  if (markdown.slice(from + 3, closeFrom) !== item.anchorText) return null;
  if (!markdown.startsWith('==}', closeFrom)) return null;
  return closeFrom + 3 === item.offset ? from : null;
}

function rootTextGone(item: RfmReviewItem): boolean {
  if (item.kind === 'comment') return empty(item.anchorText);
  if (item.kind !== 'suggestion') return false;
  if (item.suggestionKind === 'deletion') return empty(item.originalText);
  if (item.suggestionKind === 'substitution') return empty(item.originalText);
  if (item.suggestionKind === 'addition') return empty(item.text);
  return false;
}

function mergeRanges(ranges: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of ranges.sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function cleanupOrphanedRoughdraftAnnotations(markdown: string): RoughdraftAnnotationCleanupResult {
  if (!EMPTY_MARKER_HINT.test(markdown)) return { content: markdown, removedAnnotations: 0 };

  const items = extractRoughdraftReviewIndex(markdown).items.slice().sort((a, b) => a.offset - b.offset);
  const byOffset = new Map<number, RfmReviewItem>();
  for (const item of items) {
    if (item.kind === 'comment' || item.kind === 'reply') byOffset.set(item.offset, item);
  }

  const ranges: Array<{ from: number; to: number }> = [];
  for (const item of items) {
    if (!rootTextGone(item)) continue;
    if (item.kind === 'comment') {
      const from = findHighlightStart(markdown, item);
      if (from === null) continue;
      let cursor = item.offset;
      while (true) {
        const next = byOffset.get(cursor);
        if (!next || (next.kind !== 'comment' && next.kind !== 'reply')) break;
        cursor = next.endOffset;
      }
      ranges.push({ from, to: cursor });
    } else if (item.kind === 'suggestion') {
      ranges.push({ from: item.offset, to: item.endOffset });
    }
  }

  const merged = mergeRanges(ranges).filter((range) => range.to > range.from);
  if (merged.length === 0) return { content: markdown, removedAnnotations: 0 };

  let content = markdown;
  for (const range of merged.slice().reverse()) {
    content = `${content.slice(0, range.from)}${content.slice(range.to)}`;
  }

  const removedAnnotations = items.filter((item) => (
    merged.some((range) => item.offset >= range.from && item.endOffset <= range.to)
  )).length;
  return { content, removedAnnotations };
}
