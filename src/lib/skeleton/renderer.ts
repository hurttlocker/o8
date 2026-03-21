/**
 * Skeleton Map — Compact text renderer.
 *
 * Renders a SkeletonMap into a compact text block for LLM system prompt injection.
 * Supports token budgets, focus paths, and progressive pruning.
 */

import { basename, dirname } from 'node:path';
import type { FileSkeleton, RenderOptions, RenderedSkeleton, SkeletonMap, SkeletonSymbol } from './types';

const CHARS_PER_TOKEN = 4; // rough estimate

interface ScoredFile {
  file: FileSkeleton;
  score: number;
}

/**
 * Estimate token count from character count.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Score a file for priority ranking.
 * Higher score = more likely to be included in the budget.
 */
function scoreFile(file: FileSkeleton, focusPaths: string[]): number {
  let score = 0;

  // Exported symbol count is the primary signal
  const exportedCount = file.symbols.filter(s => s.exported).length;
  score += exportedCount * 3;
  score += file.symbols.length;

  // Larger files with more symbols are more important
  if (file.lineCount > 100) score += 2;
  if (file.lineCount > 500) score += 3;

  // Focus path boost (3x)
  if (focusPaths.length > 0) {
    const isFocused = focusPaths.some(fp =>
      file.relativePath.startsWith(fp) || file.relativePath.includes(fp),
    );
    if (isFocused) score *= 3;
  }

  // Deprioritize config/test/generated
  if (file.language === 'json') score *= 0.3;
  if (file.language === 'markdown') score *= 0.2;
  if (file.relativePath.includes('__test')) score *= 0.3;

  return score;
}

/**
 * Format a symbol for compact display.
 */
function formatSymbol(symbol: SkeletonSymbol, compact: boolean): string {
  if (compact) {
    // Ultra-compact: just name
    const prefix = symbol.exported ? 'export ' : '  ';
    return `${prefix}${symbol.name}`;
  }

  const exportPrefix = symbol.exported ? 'export ' : '';
  const parentPrefix = symbol.parent ? `${symbol.parent}.` : '';

  switch (symbol.kind) {
    case 'function':
    case 'method':
      return `${exportPrefix}${parentPrefix}${symbol.signature}`;
    case 'class':
      return `${exportPrefix}${symbol.signature}`;
    case 'interface':
    case 'type':
    case 'enum': {
      // For types, show the signature (which includes property names)
      return `${exportPrefix}${symbol.signature}`;
    }
    case 'const':
      return `${exportPrefix}${symbol.signature}`;
    case 'heading':
      return symbol.signature;
    case 'property':
      return `  ${parentPrefix}${symbol.signature}`;
    default:
      return `${exportPrefix}${symbol.name}`;
  }
}

/**
 * Render a skeleton map to compact text.
 */
export function renderSkeleton(map: SkeletonMap, options: RenderOptions = {}): RenderedSkeleton {
  const {
    maxTokens = 5000,
    focusPaths = [],
    includeImports = false,
    groupBy = 'directory',
  } = options;

  const maxChars = maxTokens * CHARS_PER_TOKEN;

  // Score and sort files
  const scored: ScoredFile[] = map.files
    .map(file => ({ file, score: scoreFile(file, focusPaths) }))
    .sort((a, b) => b.score - a.score);

  // Header
  const header = `[REPO MAP — ${map.repoName} · ${map.totalFiles} files · ${map.totalLines.toLocaleString()} lines]\n\n`;
  let output = header;
  let totalSymbols = 0;
  let totalFiles = 0;

  if (groupBy === 'directory') {
    // Group files by directory
    const dirGroups = new Map<string, ScoredFile[]>();
    for (const sf of scored) {
      const dir = dirname(sf.file.relativePath);
      const existing = dirGroups.get(dir);
      if (existing) {
        existing.push(sf);
      } else {
        dirGroups.set(dir, [sf]);
      }
    }

    // Sort directories: focused dirs first, then by total score
    const sortedDirs = [...dirGroups.entries()].sort((a, b) => {
      const scoreA = a[1].reduce((sum, sf) => sum + sf.score, 0);
      const scoreB = b[1].reduce((sum, sf) => sum + sf.score, 0);
      return scoreB - scoreA;
    });

    for (const [dir, files] of sortedDirs) {
      if (output.length >= maxChars) break;

      const dirLine = `${dir}/\n`;
      const remainingChars = maxChars - output.length;

      // If very little budget left, just show directory name
      if (remainingChars < 100) break;

      output += dirLine;

      for (const { file } of files) {
        if (output.length >= maxChars) break;

        const fileName = basename(file.relativePath);
        const fileLine = `  ${fileName} (${file.lineCount}L)\n`;
        output += fileLine;
        totalFiles++;

        // Include imports if requested and budget allows
        if (includeImports && file.imports.length > 0 && output.length < maxChars * 0.7) {
          for (const imp of file.imports.slice(0, 5)) {
            output += `    import "${imp}"\n`;
          }
        }

        // Symbols — exported first, then non-exported if budget allows
        const exported = file.symbols.filter(s => s.exported);
        const nonExported = file.symbols.filter(s => !s.exported && !s.parent);

        // Progressive pruning based on remaining budget
        const budgetRatio = (maxChars - output.length) / maxChars;
        const compact = budgetRatio < 0.3;

        for (const sym of exported) {
          if (output.length >= maxChars) break;
          output += `    ${formatSymbol(sym, compact)}\n`;
          totalSymbols++;
        }

        // Only include non-exported if we have > 50% budget remaining
        if (budgetRatio > 0.5) {
          for (const sym of nonExported) {
            if (output.length >= maxChars) break;
            output += `    ${formatSymbol(sym, compact)}\n`;
            totalSymbols++;
          }
        }
      }

      output += '\n';
    }
  } else {
    // Flat mode — just list files with their symbols
    for (const { file } of scored) {
      if (output.length >= maxChars) break;

      output += `${file.relativePath} (${file.lineCount}L)\n`;
      totalFiles++;

      for (const sym of file.symbols.filter(s => s.exported)) {
        if (output.length >= maxChars) break;
        output += `  ${formatSymbol(sym, false)}\n`;
        totalSymbols++;
      }
      output += '\n';
    }
  }

  return {
    text: output.trimEnd(),
    tokenEstimate: estimateTokens(output),
    fileCount: totalFiles,
    symbolCount: totalSymbols,
  };
}
